import type { Queryable } from "../queue/queue";
import { SITUACOES_VIVAS } from "@/lib/agenda/tipos";

const LINK_DE_AGENDAMENTO_GOOGLE = /https:\/\/calendar\.app\.google\/[^\s<>()]+/i;

export interface BloqueioDeNovoLinkDeAgendamento {
  code: "agenda_ja_existente";
  message: string;
}

interface CompromissoAtivo {
  starts_at: string;
  time_zone: string;
  meeting_url: string | null;
}

/**
 * Bloqueia SOMENTE um novo link de autoagendamento quando este mesmo contato já
 * possui compromisso futuro ativo. Perguntar data/horário/Meet continua livre:
 * a proteção olha para o corpo candidato e só consulta o banco se houver
 * `calendar.app.google`.
 */
export async function bloquearNovoLinkSeJaAgendado(
  db: Queryable,
  input: {
    organizationId: string;
    contactId: string;
    body: string;
    now: Date;
  },
): Promise<BloqueioDeNovoLinkDeAgendamento | null> {
  if (!LINK_DE_AGENDAMENTO_GOOGLE.test(input.body)) return null;

  const { rows } = await db.query<CompromissoAtivo>(
    `select starts_at, time_zone, meeting_url
       from calendar_appointments
      where organization_id = $1
        and contact_id = $2
        and status = any($4::text[])
        and ends_at >= $3
      order by starts_at
      limit 1`,
    [
      input.organizationId,
      input.contactId,
      input.now.toISOString(),
      SITUACOES_VIVAS,
    ],
  );

  const compromisso = rows[0];
  if (!compromisso) return null;

  const quando = `${compromisso.starts_at} (${compromisso.time_zone})`;

  const meet =
    compromisso.meeting_url?.trim()
      ? ` O link atual da reunião é ${compromisso.meeting_url.trim()}.`
      : "";

  return {
    code: "agenda_ja_existente",
    message:
      `Este contato já possui um agendamento futuro ativo em ${quando}. NÃO envie outro link de agendamento.` +
      meet +
      " Se a pessoa só pediu para lembrar data, horário ou link da reunião, responda com os dados deste compromisso. " +
      "Se ela quer outro horário, pergunte se deseja manter, remarcar ou cancelar. Só envie um novo link depois que o compromisso atual tiver sido efetivamente cancelado/remarcado pelo fluxo de agenda.",
  };
}
