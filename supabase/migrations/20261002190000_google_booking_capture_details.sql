-- Recebe do executor os campos completos do recurso events.get/list.
create or replace function public.fn_google_external_event_details(p_org uuid,p_connection uuid,p_calendar text,p_event text,p_details jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  update calendar_external_events set
    title=coalesce(nullif(p_details->>'title',''),title),
    description=p_details->>'description',
    location=p_details->>'location',
    html_link=p_details->>'html_link',
    meeting_url=p_details->>'meeting_url',
    organizer_email=p_details->>'organizer_email',
    attendee_name=p_details->>'attendee_name',
    attendee_email=p_details->>'attendee_email',
    attendees=coalesce(p_details->'attendees','[]'::jsonb),
    conference_data=p_details->'conference_data',
    raw_event=p_details,
    external_updated_at=nullif(p_details->>'external_updated_at','')::timestamptz,
    ical_uid=coalesce(nullif(p_details->>'ical_uid',''),ical_uid),
    updated_at=now()
  where organization_id=p_org and connection_id=p_connection
    and external_calendar_id=p_calendar and external_event_id=p_event;

  perform public.import_google_external_events_to_agenda(p_org,p_connection);
  perform public.fn_google_booking_link_and_enqueue(p_org);
end;$$;
revoke all on function public.fn_google_external_event_details(uuid,uuid,text,text,jsonb) from public;
