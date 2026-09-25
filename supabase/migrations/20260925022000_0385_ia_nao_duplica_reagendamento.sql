-- A IA, quando entende "trocar de dia" como "marcar outro", nao pode deixar o
-- compromisso anterior vivo. Enquanto a camada de aplicacao ainda pode estar
-- defasada no servidor, o banco fecha a porta: novo compromisso futuro criado
-- via MCP para o mesmo contato cancela os futuros anteriores desse contato.

create or replace function public.fn_cancelar_compromissos_futuros_duplicados_do_contato()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if
    new.contact_id is not null
    and coalesce(new.source, '') = 'mcp'
    and new.status in ('pending', 'confirmed')
    and new.starts_at >= now()
  then
    update public.calendar_appointments
       set status = 'cancelled',
           cancelled_at = coalesce(cancelled_at, now()),
           updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.contact_id
       and id <> new.id
       and status in ('pending', 'confirmed')
       and starts_at >= now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_cancelar_duplicado_contato_mcp on public.calendar_appointments;
create trigger trg_cancelar_duplicado_contato_mcp
after insert on public.calendar_appointments
for each row
execute function public.fn_cancelar_compromissos_futuros_duplicados_do_contato();

revoke all on function public.fn_cancelar_compromissos_futuros_duplicados_do_contato() from public, anon, authenticated;
