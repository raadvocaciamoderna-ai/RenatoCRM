-- Fecha o ciclo Google Appointment Schedule -> contato/conversa -> WhatsApp.
-- A vinculação é conservadora: somente email exato e uma única conversa WhatsApp.
-- Sem correspondência inequívoca, não envia mensagem para evitar confirmar ao cliente errado.

create or replace function public.fn_google_booking_link_and_enqueue(p_org uuid)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  r record;
  v_contact uuid;
  v_conversation uuid;
  v_job uuid;
  v_generation text;
  v_count integer := 0;
begin
  for r in
    select a.id appointment_id,a.google_event_id,e.attendee_email,e.attendee_name,
           coalesce(e.meeting_url,a.meeting_url) meeting_url
    from calendar_appointments a
    join calendar_external_events e
      on e.organization_id=a.organization_id
     and e.connection_id=a.google_connection_id
     and e.external_calendar_id=a.google_calendar_id
     and e.external_event_id=a.google_event_id
    where a.organization_id=p_org
      and a.source='google_sync'
      and a.status='confirmed'
      and a.google_booking_confirmation_sent_at is null
      and e.attendee_email is not null
  loop
    select c.id into v_contact
    from contacts c
    where c.organization_id=p_org
      and lower(coalesce(c.email_normalized,c.email,''))=lower(r.attendee_email)
      and not c.is_anonymized
    order by c.updated_at desc limit 1;

    if v_contact is null then continue; end if;

    select v.id into v_conversation
    from conversations v
    where v.organization_id=p_org and v.contact_id=v_contact
      and v.channel='whatsapp'
    order by v.last_message_at desc nulls last,v.updated_at desc
    limit 1;

    if v_conversation is null then continue; end if;

    v_generation:=gen_random_uuid()::text;
    v_job:=gen_random_uuid();

    update calendar_appointments
    set contact_id=v_contact,
        meeting_url=coalesce(r.meeting_url,meeting_url),
        location_kind=case when coalesce(r.meeting_url,meeting_url) is not null then 'google_meet' else location_kind end,
        meeting_delivery_job_id=v_job,
        meeting_delivery=jsonb_build_object(
          'state','pending',
          'generation',v_generation,
          'authorized_by',jsonb_build_object('kind','system','source','google_booking_sync')
        ),
        updated_at=now()
    where organization_id=p_org and id=r.appointment_id
      and google_booking_confirmation_sent_at is null;

    insert into job_queue(id,organization_id,contact_id,kind,payload,status,priority,run_after)
    values(
      v_job,p_org,v_contact,'transactional_delivery',
      jsonb_build_object(
        'appointment_id',r.appointment_id::text,
        'delivery_generation',v_generation,
        'motivo','primeiro_envio',
        'service_boundary',jsonb_build_object(
          'conversation_id',v_conversation::text,
          'contact_id',v_contact::text
        )
      ),
      'pending',50,now()
    )
    on conflict(id) do nothing;

    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.fn_google_booking_link_and_enqueue(uuid) from public;
