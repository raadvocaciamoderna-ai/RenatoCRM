-- Importa eventos externos do Google para a agenda nativa do CRM.
-- Idempotente por (organization_id, google_connection_id, google_calendar_id, google_event_id).
-- O worker de sincronizacao continua responsavel por preencher calendar_external_events.

create unique index if not exists calendar_appointments_google_event_unique
  on public.calendar_appointments
  (organization_id, google_connection_id, google_calendar_id, google_event_id)
  where google_event_id is not null;

create or replace function public.import_google_external_events_to_agenda(
  p_organization_id uuid,
  p_connection_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  insert into public.calendar_appointments (
    organization_id,
    title,
    starts_at,
    ends_at,
    time_zone,
    status,
    created_by_kind,
    source,
    google_connection_id,
    google_calendar_id,
    google_event_id,
    google_ical_uid,
    google_synced_at,
    created_at,
    updated_at
  )
  select
    e.organization_id,
    coalesce(nullif(e.title, ''), 'Agendamento Google'),
    e.starts_at,
    e.ends_at,
    coalesce(c.time_zone, 'America/Sao_Paulo'),
    case when e.status = 'cancelled' then 'cancelled' else 'confirmed' end,
    'integration',
    'google_external',
    e.connection_id,
    e.external_calendar_id,
    e.external_event_id,
    e.ical_uid,
    now(),
    now(),
    now()
  from public.calendar_external_events e
  join public.calendar_connection_calendars c
    on c.organization_id=e.organization_id
   and c.connection_id=e.connection_id
   and c.external_calendar_id=e.external_calendar_id
  where e.organization_id=p_organization_id
    and (p_connection_id is null or e.connection_id=p_connection_id)
    and c.available=true
    and e.starts_at is not null
    and e.ends_at is not null
  on conflict (organization_id, google_connection_id, google_calendar_id, google_event_id)
    where google_event_id is not null
  do update set
    title=excluded.title,
    starts_at=excluded.starts_at,
    ends_at=excluded.ends_at,
    time_zone=excluded.time_zone,
    status=excluded.status,
    google_ical_uid=excluded.google_ical_uid,
    google_synced_at=now(),
    updated_at=now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.import_google_external_events_to_agenda(uuid,uuid) from public;
