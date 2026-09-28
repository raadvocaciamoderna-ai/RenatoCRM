-- Pagamentos Asaas avançados: vínculo com contato, parcelamentos e assinaturas.

alter table public.asaas_payments
  add column if not exists contact_id uuid references public.contacts(id) on delete set null,
  add column if not exists installment_id text,
  add column if not exists subscription_id text,
  add column if not exists installment_number integer check (installment_number is null or installment_number >= 1);

create index if not exists asaas_payments_org_contact_idx
  on public.asaas_payments (organization_id, contact_id, created_at desc);

create index if not exists asaas_payments_installment_idx
  on public.asaas_payments (installment_id)
  where installment_id is not null;

create index if not exists asaas_payments_subscription_idx
  on public.asaas_payments (subscription_id)
  where subscription_id is not null;

create table if not exists public.asaas_installments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  asaas_installment_id text not null,
  asaas_customer_id text not null,
  billing_type text not null
    check (billing_type in ('UNDEFINED', 'BOLETO', 'CREDIT_CARD', 'PIX')),
  total_amount_cents bigint not null check (total_amount_cents > 0),
  installment_count integer not null check (installment_count between 2 and 24),
  first_due_date date not null,
  description text,
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  account_plan_id uuid references public.account_plans(id) on delete restrict,
  status text not null default 'ACTIVE',
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asaas_installments_org_remote_key unique (organization_id, asaas_installment_id)
);

create index if not exists asaas_installments_org_contact_idx
  on public.asaas_installments (organization_id, contact_id, created_at desc);

create table if not exists public.asaas_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  asaas_subscription_id text not null,
  asaas_customer_id text not null,
  billing_type text not null
    check (billing_type in ('UNDEFINED', 'BOLETO', 'CREDIT_CARD', 'PIX')),
  amount_cents bigint not null check (amount_cents > 0),
  cycle text not null
    check (cycle in ('WEEKLY','BIWEEKLY','MONTHLY','BIMONTHLY','QUARTERLY','SEMIANNUALLY','YEARLY')),
  next_due_date date not null,
  description text,
  max_payments integer check (max_payments is null or max_payments >= 1),
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  account_plan_id uuid references public.account_plans(id) on delete restrict,
  status text not null default 'ACTIVE',
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asaas_subscriptions_org_remote_key unique (organization_id, asaas_subscription_id)
);

create index if not exists asaas_subscriptions_org_contact_idx
  on public.asaas_subscriptions (organization_id, contact_id, created_at desc);

do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'fn_touch_updated_at') then
    foreach t in array array['asaas_installments', 'asaas_subscriptions'] loop
      execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
      execute format(
        'create trigger trg_%I_touch before update on public.%I for each row execute function public.fn_touch_updated_at()',
        t, t
      );
    end loop;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['asaas_installments', 'asaas_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_%I_all on public.%I', t, t);
    execute format($f$
      create policy tenant_isolation_%I_all on public.%I
        for all
        using (
          organization_id in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin()
        )
        with check (
          public.fn_is_platform_admin()
          or (
            organization_id in (select public.fn_user_org_ids())
            and public.fn_role_at_least(organization_id, 'agent')
          )
        )
    $f$, t, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

grant select, insert, update on public.asaas_installments to authenticated, service_role;
grant select, insert, update on public.asaas_subscriptions to authenticated, service_role;

comment on table public.asaas_installments is
  'Parcelamentos Asaas criados pelo CRM; cada parcela também é persistida em asaas_payments.';
comment on table public.asaas_subscriptions is
  'Assinaturas recorrentes Asaas criadas pelo CRM; cobranças geradas são reconciliadas por webhook.';
