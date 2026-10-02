-- Mantém o ciclo de sincronização do Google em 1 minuto após sucesso
-- e permite que compromissos importados (source='google_sync') sejam
-- enriquecidos novamente em um full resync sem serem tratados como eventos
-- criados pelo próprio CRM.
do $$
declare
  v text;
  old_guard text := '          and google_event_id=it->>''external_event_id''
      ) then';
  new_guard text := '          and google_event_id=it->>''external_event_id''
          and source<>''google_sync''
      ) then';
begin
  select pg_get_functiondef('public.fn_google_calendar(uuid,uuid,text,jsonb)'::regprocedure)
    into v;

  -- Sucesso: próxima leitura em 1 minuto. O backoff de erro continua 15 min.
  v := replace(
    v,
    'sync_next_attempt_at=now()+interval ''15 minutes''
        where organization_id=p_org and id=p_id
        returning * into c;',
    'sync_next_attempt_at=now()+interval ''1 minute''
        where organization_id=p_org and id=p_id
        returning * into c;'
  );

  -- Evento importado do Google continua sendo externo e precisa ser
  -- reprocessado/enriquecido em resync; só eventos nativos do CRM entram
  -- no caminho de reconciliação interna.
  if position('source<>''google_sync''' in v) = 0 then
    if position(old_guard in v) = 0 then
      raise exception 'fn_google_calendar source guard pattern not found';
    end if;
    v := replace(v, old_guard, new_guard);
  end if;

  execute v;
end
$$;
