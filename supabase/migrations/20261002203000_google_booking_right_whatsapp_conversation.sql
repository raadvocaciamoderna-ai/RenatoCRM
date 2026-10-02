-- Correlação segura de reservas do Google com a conversa WhatsApp certa.
-- Evita herdar contato de compromisso antigo pelo mesmo e-mail e registra
-- a intenção de agendamento quando o link oficial é enviado.

create table if not exists public.calendar_booking_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  sent_at timestamptz not null,
  booking_url text not null,
  consumed_event_id text,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, message_id)
);

create unique index if not exists calendar_booking_intents_event_unique
  on public.calendar_booking_intents(organization_id, consumed_event_id)
  where consumed_event_id is not null;

create index if not exists calendar_booking_intents_pending_idx
  on public.calendar_booking_intents(organization_id, sent_at desc);

alter table public.calendar_booking_intents enable row level security;

create or replace function public.fn_capture_google_booking_intent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction='outbound'
     and new.contact_id is not null
     and new.conversation_id is not null
     and coalesce(new.body,'') like '%https://calendar.app.google/hmSettm7LFfaUAQs5%'
     and coalesce(new.sent_via,'') <> 'external_device' then
    insert into public.calendar_booking_intents(
      organization_id,contact_id,conversation_id,message_id,sent_at,booking_url
    )
    values(
      new.organization_id,new.contact_id,new.conversation_id,new.id,
      coalesce(new.sent_at,new.created_at,now()),
      'https://calendar.app.google/hmSettm7LFfaUAQs5'
    )
    on conflict(organization_id,message_id) do nothing;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_capture_google_booking_intent on public.messages;
create trigger trg_capture_google_booking_intent
after insert on public.messages
for each row
execute function public.fn_capture_google_booking_intent();

insert into public.calendar_booking_intents(
  organization_id,contact_id,conversation_id,message_id,sent_at,booking_url
)
select
  m.organization_id,m.contact_id,m.conversation_id,m.id,
  coalesce(m.sent_at,m.created_at),
  'https://calendar.app.google/hmSettm7LFfaUAQs5'
from public.messages m
where m.direction='outbound'
  and m.contact_id is not null
  and m.conversation_id is not null
  and coalesce(m.body,'') like '%https://calendar.app.google/hmSettm7LFfaUAQs5%'
  and coalesce(m.sent_via,'') <> 'external_device'
on conflict(organization_id,message_id) do nothing;

create or replace function public.fn_google_booking_link_and_enqueue(p_org uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_contact uuid;
  v_conversation uuid;
  v_channel_session uuid;
  v_owner_user uuid;
  v_job uuid;
  v_generation text;
  v_meeting_request uuid;
  v_service_revision bigint;
  v_demanda uuid;
  v_demanda_revision bigint;
  v_boundary jsonb;
  v_count integer:=0;
  v_matches integer;
  v_conversation_count integer;
  v_intent_id uuid;
  v_event_time timestamptz;
begin
  for r in
    select
      a.id appointment_id,
      a.google_event_id,
      a.google_connection_id,
      a.meeting_request_id,
      e.attendee_email,
      e.attendee_name,
      coalesce(e.meeting_url,a.meeting_url) meeting_url,
      coalesce(e.external_updated_at,e.updated_at) event_time
    from public.calendar_appointments a
    join public.calendar_external_events e
      on e.organization_id=a.organization_id
     and e.connection_id=a.google_connection_id
     and e.external_calendar_id=a.google_calendar_id
     and e.external_event_id=a.google_event_id
    where a.organization_id=p_org
      and a.source='google_sync'
      and a.status='confirmed'
      and a.google_booking_confirmation_sent_at is null
      and a.meeting_delivery_job_id is null
  loop
    v_contact:=null;
    v_conversation:=null;
    v_channel_session:=null;
    v_owner_user:=null;
    v_intent_id:=null;
    v_matches:=0;
    v_event_time:=coalesce(r.event_time,now());

    if r.attendee_email is not null then
      select count(distinct c.id), (array_agg(distinct c.id))[1]
        into v_matches,v_contact
      from public.contacts c
      where c.organization_id=p_org
        and lower(coalesce(c.email_normalized,c.email,''))=lower(r.attendee_email)
        and not c.is_anonymized;
    end if;

    if v_matches=1 then
      select
        v.id,v.channel_session_id,v.service_revision,v.current_demanda_id,d.revision
      into
        v_conversation,v_channel_session,v_service_revision,v_demanda,v_demanda_revision
      from public.conversations v
      left join public.demandas d
        on d.organization_id=v.organization_id
       and d.contact_id=v.contact_id
       and d.id=v.current_demanda_id
      where v.organization_id=p_org
        and v.contact_id=v_contact
        and v.channel='whatsapp'
        and not v.is_group
        and v.status not in ('closed','resolved','archived')
      order by v.last_message_at desc nulls last,v.updated_at desc
      limit 1;
    else
      -- Sem e-mail único: correlaciona pelo contexto da conversa que recebeu
      -- o link pouco antes da criação da reserva. Vários links na MESMA conversa
      -- não geram ambiguidade; duas conversas distintas geram e não enviamos.
      select count(distinct i.conversation_id)
        into v_conversation_count
      from public.calendar_booking_intents i
      where i.organization_id=p_org
        and i.sent_at <= v_event_time + interval '2 minutes'
        and i.sent_at >= v_event_time - interval '45 minutes';

      if v_conversation_count=1 then
        select i.id,i.contact_id,i.conversation_id
          into v_intent_id,v_contact,v_conversation
        from public.calendar_booking_intents i
        where i.organization_id=p_org
          and i.sent_at <= v_event_time + interval '2 minutes'
          and i.sent_at >= v_event_time - interval '45 minutes'
        order by i.sent_at desc
        limit 1;

        select
          v.channel_session_id,v.service_revision,v.current_demanda_id,d.revision
        into
          v_channel_session,v_service_revision,v_demanda,v_demanda_revision
        from public.conversations v
        left join public.demandas d
          on d.organization_id=v.organization_id
         and d.contact_id=v.contact_id
         and d.id=v.current_demanda_id
        where v.organization_id=p_org
          and v.id=v_conversation
          and v.contact_id=v_contact
          and v.channel='whatsapp'
          and not v.is_group
          and v.status not in ('closed','resolved','archived');
      end if;
    end if;

    if v_contact is null or v_conversation is null or v_channel_session is null then
      continue;
    end if;

    select cc.user_id
      into v_owner_user
    from public.calendar_connections cc
    where cc.organization_id=p_org
      and cc.id=r.google_connection_id
      and cc.status='healthy'
    limit 1;

    if v_owner_user is null then
      continue;
    end if;

    v_boundary:=jsonb_build_object(
      'organization_id',p_org::text,
      'contact_id',v_contact::text,
      'conversation_id',v_conversation::text,
      'service_revision',v_service_revision,
      'demanda_id',case when v_demanda is null then null else to_jsonb(v_demanda::text) end,
      'demanda_revision',v_demanda_revision
    );

    v_generation:=gen_random_uuid()::text;
    v_job:=gen_random_uuid();
    v_meeting_request:=coalesce(r.meeting_request_id,gen_random_uuid());

    insert into public.job_queue(
      id,organization_id,contact_id,kind,payload,status,priority,run_after
    )
    values(
      v_job,p_org,v_contact,'transactional_delivery',
      jsonb_build_object(
        'appointment_id',r.appointment_id::text,
        'meeting_request_id',v_meeting_request::text,
        'delivery_generation',v_generation,
        'motivo','primeiro_envio',
        'service_boundary',v_boundary
      ),
      'pending',50,now()
    );

    update public.calendar_appointments
    set
      owner_user_id=coalesce(owner_user_id,v_owner_user),
      contact_id=v_contact,
      conversation_id=v_conversation,
      guest_email=r.attendee_email,
      meeting_url=coalesce(r.meeting_url,meeting_url),
      location_kind=case
        when coalesce(r.meeting_url,meeting_url) is not null then 'google_meet'
        else location_kind
      end,
      meeting_state=case
        when coalesce(r.meeting_url,meeting_url) is not null then 'ready'
        else meeting_state
      end,
      meeting_request_id=v_meeting_request,
      meeting_received_at=case
        when coalesce(r.meeting_url,meeting_url) is not null then coalesce(meeting_received_at,now())
        else meeting_received_at
      end,
      meeting_delivery_job_id=v_job,
      meeting_delivery=jsonb_build_object(
        'state','queued',
        'generation',v_generation,
        'authorized_by',jsonb_build_object('kind','system','source','google_booking_sync'),
        'channel_session_id',v_channel_session::text,
        'service_boundary',v_boundary
      ),
      updated_at=now()
    where organization_id=p_org
      and id=r.appointment_id
      and google_booking_confirmation_sent_at is null
      and meeting_delivery_job_id is null;

    if not found then
      delete from public.job_queue where id=v_job;
      continue;
    end if;

    if v_intent_id is not null then
      update public.calendar_booking_intents
      set consumed_event_id=r.google_event_id, consumed_at=now()
      where organization_id=p_org
        and id=v_intent_id
        and consumed_event_id is null;
    end if;

    v_count:=v_count+1;
  end loop;

  return v_count;
end;
$function$;

-- Entrega transacional criada pelo sync do Google é autorizada pelo sistema.
create or replace function public.fn_meet_delivery_current(
  p_org uuid,
  p_job uuid,
  p_worker text,
  p_acquired_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
 select exists(
  select 1
  from public.job_queue j
  join public.calendar_appointments a
    on a.organization_id=j.organization_id
   and a.id::text=j.payload->>'appointment_id'
  join public.contacts c
    on c.organization_id=a.organization_id
   and c.id=a.contact_id
  join public.conversations v
    on v.organization_id=a.organization_id
   and v.contact_id=a.contact_id
   and v.id::text=j.payload->'service_boundary'->>'conversation_id'
  join public.channel_sessions cs
    on cs.organization_id=v.organization_id
   and cs.id=v.channel_session_id
  join public.organizations o
    on o.id=a.organization_id
   and o.status='active'
  where cs.archived_at is null
    and a.meeting_delivery->>'channel_session_id'=cs.id::text
    and j.organization_id=p_org
    and j.id=p_job
    and j.kind='transactional_delivery'
    and j.status='running'
    and j.locked_by=p_worker
    and j.locked_at=p_acquired_at
    and a.contact_id=j.contact_id
    and not c.is_anonymized
    and not c.is_blocked
    and a.status<>'cancelled'
    and (
      a.location_kind<>'google_meet'
      or (a.meeting_state='ready' and a.meeting_url is not null)
    )
    and a.meeting_request_id::text=j.payload->>'meeting_request_id'
    and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation'
    and a.meeting_delivery_job_id=j.id
    and a.meeting_delivery->>'state'='queued'
    and exists(
      select 1 from public.user_organizations
      where organization_id=p_org
        and user_id=a.owner_user_id
        and revoked_at is null
    )
    and (
      a.meeting_delivery->'authorized_by'->>'kind'='ai_agent'
      or (
        a.meeting_delivery->'authorized_by'->>'kind'='user'
        and a.meeting_delivery->'authorized_by'->>'id'=a.owner_user_id::text
        and exists(
          select 1
          from public.user_organizations u
          where u.organization_id=p_org
            and u.user_id=a.owner_user_id
            and u.revoked_at is null
            and u.role in ('agent','manager','admin')
            and (
              u.role in ('manager','admin')
              or v.assigned_to_user_id=u.user_id
              or o.settings->>'visibility_mode'='all'
              or (
                coalesce(o.settings->>'visibility_mode','own_and_unassigned')='own_and_unassigned'
                and v.assigned_to_user_id is null
              )
            )
        )
      )
      or (
        a.source='google_sync'
        and a.meeting_delivery->'authorized_by'->>'kind'='system'
        and a.meeting_delivery->'authorized_by'->>'source'='google_booking_sync'
      )
    )
    and a.meeting_delivery->'service_boundary'=j.payload->'service_boundary'
    and public.fn_meet_boundary_current(j.payload->'service_boundary')
 );
$function$;

create or replace function public.fn_meet_delivery_policy(
  p_org uuid,
  p_job uuid,
  p_worker text,
  p_acquired_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare r record;
begin
 select
   a.meeting_delivery,
   a.contact_id,
   a.source,
   v.channel_session_id,
   c.is_blocked,
   c.is_anonymized,
   c.force_human,
   c.ai_authorized_at,
   v.assignee_kind,
   v.bot_silenced_until,
   cs.metadata,
   cs.archived_at,
   public.fn_meet_delivery_current(p_org,p_job,p_worker,p_acquired_at) as current
 into r
 from public.job_queue j
 join public.calendar_appointments a
   on a.organization_id=j.organization_id
  and a.id::text=j.payload->>'appointment_id'
 join public.contacts c
   on c.organization_id=a.organization_id
  and c.id=a.contact_id
 join public.conversations v
   on v.organization_id=a.organization_id
  and v.contact_id=a.contact_id
  and v.id::text=j.payload->'service_boundary'->>'conversation_id'
 join public.channel_sessions cs
   on cs.organization_id=v.organization_id
  and cs.id=v.channel_session_id
 where j.organization_id=p_org
   and j.id=p_job
   and j.kind='transactional_delivery'
   and j.status='running'
   and j.locked_by=p_worker
   and j.locked_at=p_acquired_at
   and a.meeting_delivery_job_id=j.id
   and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation';

 if not found then
   return jsonb_build_object('current',false,'reason','stale');
 end if;

 if not r.current then
   return jsonb_build_object(
     'current',false,
     'reason',
     case
       when r.is_anonymized then 'lgpd'
       when r.is_blocked then 'opt_out'
       when r.archived_at is not null then 'channel'
       else 'access_or_stale'
     end
   );
 end if;

 return jsonb_build_object(
   'current',true,
   'contact_id',r.contact_id,
   'channel_session_id',r.channel_session_id,
   'human_command',
     (
       r.meeting_delivery->'authorized_by'->>'kind'='user'
       or (
         r.source='google_sync'
         and r.meeting_delivery->'authorized_by'->>'kind'='system'
         and r.meeting_delivery->'authorized_by'->>'source'='google_booking_sync'
       )
     ),
   'force_human',r.force_human,
   'ai_gate',r.metadata->>'ai_gate',
   'ai_authorized_at',r.ai_authorized_at,
   'assignee_kind',r.assignee_kind,
   'bot_silenced_until',r.bot_silenced_until
 );
end;
$function$;

create or replace function public.fn_stamp_google_booking_confirmation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_message uuid;
begin
  if new.kind='transactional_delivery'
     and new.status='done'
     and old.status is distinct from new.status then
    select sl.crm_message_id
      into v_message
    from public.send_ledger sl
    where sl.organization_id=new.organization_id
      and sl.job_id=new.id
      and sl.seq=1
      and sl.status='accepted'
    order by sl.updated_at desc
    limit 1;

    update public.calendar_appointments a
    set
      google_booking_confirmation_sent_at=coalesce(a.google_booking_confirmation_sent_at,now()),
      google_booking_confirmation_message_id=coalesce(a.google_booking_confirmation_message_id,v_message),
      updated_at=now()
    where a.organization_id=new.organization_id
      and a.id::text=new.payload->>'appointment_id'
      and a.source='google_sync';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_stamp_google_booking_confirmation on public.job_queue;
create trigger trg_stamp_google_booking_confirmation
after update of status on public.job_queue
for each row
when (new.kind='transactional_delivery' and new.status='done')
execute function public.fn_stamp_google_booking_confirmation();
