-- Integração Asaas (Sandbox/Produção) no módulo financeiro.
--
-- A chave da API NÃO mora no banco: fica no ambiente da instalação.
-- O banco guarda apenas identificadores externos, estado da cobrança e o vínculo
-- com a conta financeira da organização.
--
-- O dinheiro só entra em financial_entries quando o Asaas envia PAYMENT_RECEIVED.
-- PAYMENT_CONFIRMED não basta: no próprio Asaas ele pode significar pagamento
-- confirmado cujo saldo ainda não está disponível.

-- ─── origem do lançamento financeiro ────────────────────────────────────────
alter table public.financial_entries
  drop constraint if exists financial_entries_origin_check;

alter table public.financial_entries
  add constraint financial_entries_origin_check
  check (origin in ('manual', 'sale', 'reversal', 'recurring', 'asaas'));

-- ─── vínculo contato ↔ cliente Asaas ─────────────────────────────────────────
create table if not exists public.asaas_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  asaas_customer_id text not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint asaas_customers_org_remote_key unique (organization_id, asaas_customer_id)
);

create unique index if not exists asaas_customers_org_contact_key
  on public.asaas_customers (organization_id, contact_id)
  where contact_id is not null;

-- ─── cobrança Asaas gerenciada pelo CRM ──────────────────────────────────────
create table if not exists public.asaas_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  asaas_payment_id text,
  asaas_customer_id text not null,
  external_reference text not null,

  billing_type text not null
    check (billing_type in ('UNDEFINED', 'BOLETO', 'CREDIT_CARD', 'PIX')),
  amount_cents bigint not null check (amount_cents > 0),
  due_date date not null,
  description text,

  status text not null default 'CREATING',
  invoice_url text,

  -- Para onde o recebimento vai quando PAYMENT_RECEIVED chegar.
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  account_plan_id uuid references public.account_plans(id) on delete restrict,

  -- Criados somente após o evento financeiro correspondente.
  financial_entry_id uuid unique references public.financial_entries(id) on delete restrict,
  reversal_entry_id uuid unique references public.financial_entries(id) on delete restrict,

  last_event_id text,
  last_event_type text,
  last_error text,
  needs_reconciliation boolean not null default false,

  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint asaas_payments_external_reference_key unique (external_reference)
);

create unique index if not exists asaas_payments_remote_key
  on public.asaas_payments (asaas_payment_id)
  where asaas_payment_id is not null;

create index if not exists asaas_payments_org_status_idx
  on public.asaas_payments (organization_id, status, due_date desc);

-- ─── idempotência dos webhooks ───────────────────────────────────────────────
--
-- O Asaas entrega "at least once": o mesmo evento pode voltar. A linha fica
-- mesmo quando o processamento falha; processed_at nulo permite reprocessar o
-- MESMO id numa tentativa seguinte sem criar um segundo efeito financeiro.
create table if not exists public.asaas_webhook_events (
  event_id text primary key,
  event_type text not null,
  asaas_payment_id text,
  organization_id uuid references public.organizations(id) on delete set null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists asaas_webhook_events_payment_idx
  on public.asaas_webhook_events (asaas_payment_id, created_at desc);

-- ─── updated_at ──────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'fn_touch_updated_at') then
    foreach t in array array['asaas_customers', 'asaas_payments'] loop
      execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
      execute format(
        'create trigger trg_%I_touch before update on public.%I for each row execute function public.fn_touch_updated_at()',
        t, t
      );
    end loop;
  end if;
end $$;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['asaas_customers', 'asaas_payments'] loop
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

grant select, insert, update on public.asaas_customers to authenticated, service_role;
grant select, insert, update on public.asaas_payments to authenticated, service_role;

alter table public.asaas_webhook_events enable row level security;
revoke all on public.asaas_webhook_events from anon, authenticated;
grant select, insert, update on public.asaas_webhook_events to service_role;

-- ─── contabilização idempotente do recebimento ───────────────────────────────
--
-- O lock na cobrança local impede dois webhooks concorrentes de criarem duas
-- entradas. Só service_role executa: o endpoint público valida o token do Asaas
-- antes de chegar aqui e usa o client admin.
create or replace function public.fn_asaas_payment_received(
  p_local_payment uuid,
  p_paid_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.asaas_payments%rowtype;
  v_entry uuid;
begin
  select * into v_payment
    from public.asaas_payments
   where id = p_local_payment
   for update;

  if not found then
    raise exception 'asaas_payment_not_found' using errcode = 'P0002';
  end if;

  if v_payment.financial_entry_id is not null then
    return jsonb_build_object(
      'entry_id', v_payment.financial_entry_id,
      'created', false
    );
  end if;

  insert into public.financial_entries (
    organization_id,
    account_id,
    account_plan_id,
    direction,
    amount_cents,
    currency,
    description,
    entry_date,
    status,
    paid_at,
    origin,
    created_by_user_id
  ) values (
    v_payment.organization_id,
    v_payment.account_id,
    v_payment.account_plan_id,
    'in',
    v_payment.amount_cents,
    'BRL',
    coalesce(v_payment.description, 'Recebimento Asaas'),
    (coalesce(p_paid_at, now()) at time zone 'UTC')::date,
    'paid',
    coalesce(p_paid_at, now()),
    'asaas',
    v_payment.created_by_user_id
  )
  returning id into v_entry;

  update public.asaas_payments
     set financial_entry_id = v_entry,
         needs_reconciliation = false
   where id = v_payment.id;

  return jsonb_build_object('entry_id', v_entry, 'created', true);
end $$;

revoke execute on function public.fn_asaas_payment_received(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_asaas_payment_received(uuid, timestamptz)
  to service_role;

-- ─── estorno integral idempotente ────────────────────────────────────────────
create or replace function public.fn_asaas_payment_refunded(
  p_local_payment uuid,
  p_refunded_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.asaas_payments%rowtype;
  v_original public.financial_entries%rowtype;
  v_reversal uuid;
begin
  select * into v_payment
    from public.asaas_payments
   where id = p_local_payment
   for update;

  if not found then
    raise exception 'asaas_payment_not_found' using errcode = 'P0002';
  end if;

  if v_payment.reversal_entry_id is not null then
    return jsonb_build_object(
      'entry_id', v_payment.reversal_entry_id,
      'created', false
    );
  end if;

  -- Se ainda não houve recebimento, não há dinheiro local para estornar.
  if v_payment.financial_entry_id is null then
    return jsonb_build_object('entry_id', null, 'created', false, 'nothing_to_reverse', true);
  end if;

  select * into v_original
    from public.financial_entries
   where id = v_payment.financial_entry_id
     and organization_id = v_payment.organization_id;

  if not found then
    raise exception 'asaas_financial_entry_not_found' using errcode = 'P0002';
  end if;

  insert into public.financial_entries (
    organization_id,
    account_id,
    account_plan_id,
    direction,
    amount_cents,
    currency,
    description,
    entry_date,
    status,
    paid_at,
    origin,
    reverses_entry_id,
    created_by_user_id
  ) values (
    v_payment.organization_id,
    v_original.account_id,
    null,
    'out',
    v_original.amount_cents,
    v_original.currency,
    'Estorno Asaas ' || coalesce(v_payment.asaas_payment_id, v_payment.id::text),
    (coalesce(p_refunded_at, now()) at time zone 'UTC')::date,
    'paid',
    coalesce(p_refunded_at, now()),
    'reversal',
    v_original.id,
    v_payment.created_by_user_id
  )
  returning id into v_reversal;

  update public.asaas_payments
     set reversal_entry_id = v_reversal,
         needs_reconciliation = false
   where id = v_payment.id;

  return jsonb_build_object('entry_id', v_reversal, 'created', true);
end $$;

revoke execute on function public.fn_asaas_payment_refunded(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_asaas_payment_refunded(uuid, timestamptz)
  to service_role;

comment on table public.asaas_payments is
  'Cobranças Asaas criadas pelo CRM. O lançamento financeiro nasce somente em PAYMENT_RECEIVED.';
comment on table public.asaas_webhook_events is
  'Idempotência mínima dos webhooks Asaas: um event_id pode ser recebido várias vezes sem repetir efeito.';
