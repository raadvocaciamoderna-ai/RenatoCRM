-- Dados completos necessários para confirmar no WhatsApp uma reserva criada
-- pela página pública do Google Calendar.
alter table public.calendar_external_events
  add column if not exists description text,
  add column if not exists location text,
  add column if not exists html_link text,
  add column if not exists meeting_url text,
  add column if not exists organizer_email text,
  add column if not exists attendee_name text,
  add column if not exists attendee_email text,
  add column if not exists attendees jsonb not null default '[]'::jsonb,
  add column if not exists conference_data jsonb,
  add column if not exists raw_event jsonb;

alter table public.calendar_appointments
  add column if not exists google_booking_confirmation_sent_at timestamptz,
  add column if not exists google_booking_confirmation_message_id uuid references public.messages(id) on delete set null;

create index if not exists calendar_appointments_google_confirmation_pending_idx
  on public.calendar_appointments (organization_id, starts_at)
  where source='google_sync'
    and google_booking_confirmation_sent_at is null
    and status='confirmed';

comment on column public.calendar_external_events.meeting_url is
  'URL real da videoconferencia retornada pelo Google Calendar (hangoutLink/conferenceData).';
comment on column public.calendar_external_events.attendee_email is
  'Email principal do cliente/convidado usado para vincular a reserva ao contato do CRM.';
