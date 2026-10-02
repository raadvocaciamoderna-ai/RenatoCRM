-- Imported Google Appointment Schedule bookings need a CRM event type before
-- the AI can safely reschedule them. We infer only when the mapping is
-- unambiguous: same owner, active type, same duration, Google Meet.
create or replace function public.import_google_external_events_to_agenda(
  p_organization_id uuid,
  p_connection_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
begin
  insert into public.calendar_appointments(
    organization_id,
    event_type_id,
    owner_user_id,
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
    inferred.event_type_id,
    conn.user_id,
    coalesce(nullif(e.title,''),'Agendamento Google'),
    e.starts_at,
    e.ends_at,
    coalesce(c.time_zone,'America/Sao_Paulo'),
    case when e.status='cancelled' then 'cancelled' else 'confirmed' end,
    'sync',
    'google_sync',
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
  join public.calendar_connections conn
    on conn.organization_id=e.organization_id
   and conn.id=e.connection_id
  left join lateral (
    select (array_agg(t.id order by t.created_at))[1] as event_type_id
    from public.calendar_event_types t
    where t.organization_id=e.organization_id
      and t.is_active=true
      and t.default_owner_user_id=conn.user_id
      and t.location_kind='google_meet'
      and e.meeting_url is not null
      and t.duration_minutes =
        round(extract(epoch from (e.ends_at-e.starts_at))/60.0)::integer
    having count(*)=1
  ) inferred on true
  where e.organization_id=p_organization_id
    and (p_connection_id is null or e.connection_id=p_connection_id)
    and c.available=true
    and e.starts_at is not null
    and e.ends_at is not null
  on conflict(organization_id,google_connection_id,google_calendar_id,google_event_id)
    where google_event_id is not null
  do update set
    event_type_id=coalesce(
      public.calendar_appointments.event_type_id,
      excluded.event_type_id
    ),
    owner_user_id=coalesce(
      public.calendar_appointments.owner_user_id,
      excluded.owner_user_id
    ),
    title=excluded.title,
    starts_at=excluded.starts_at,
    ends_at=excluded.ends_at,
    time_zone=excluded.time_zone,
    status=excluded.status,
    google_ical_uid=excluded.google_ical_uid,
    google_synced_at=now(),
    updated_at=now();

  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

-- Backfill bookings already imported before this rule existed. Ambiguous matches
-- remain NULL rather than choosing an arbitrary service.
with matches as (
  select
    a.id,
    conn.user_id as owner_user_id,
    inferred.event_type_id
  from public.calendar_appointments a
  join public.calendar_connections conn
    on conn.organization_id=a.organization_id
   and conn.id=a.google_connection_id
  left join lateral (
    select (array_agg(t.id order by t.created_at))[1] as event_type_id
    from public.calendar_event_types t
    where t.organization_id=a.organization_id
      and t.is_active=true
      and t.default_owner_user_id=conn.user_id
      and t.location_kind='google_meet'
      and a.meeting_url is not null
      and t.duration_minutes =
        round(extract(epoch from (a.ends_at-a.starts_at))/60.0)::integer
    having count(*)=1
  ) inferred on true
  where a.source='google_sync'
    and a.event_type_id is null
    and a.google_event_id is not null
)
update public.calendar_appointments a
set
  event_type_id=m.event_type_id,
  owner_user_id=coalesce(a.owner_user_id,m.owner_user_id),
  updated_at=now()
from matches m
where a.id=m.id
  and m.event_type_id is not null;
