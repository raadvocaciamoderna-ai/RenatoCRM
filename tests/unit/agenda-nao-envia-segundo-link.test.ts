import { describe, expect, it } from "vitest";

import { bloquearNovoLinkSeJaAgendado } from "@/lib/agent-engine/agent/bloqueio-novo-link-agendamento";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-10-02T22:00:00.000Z");

function db(rows: unknown[] = []) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  return {
    chamadas,
    q: {
      query: async (sql: string, params: unknown[] = []) => {
        chamadas.push({ sql, params });
        return { rows };
      },
    } as never,
  };
}

describe("proteção contra segundo link de agendamento", () => {
  it("⭐ link do Google Calendar é bloqueado quando o contato já tem compromisso vivo", async () => {
    const { q } = db([
      {
        starts_at: "2026-10-05T13:00:00.000Z",
        time_zone: "America/Sao_Paulo",
        meeting_url: "https://meet.google.com/abc-defg-hij",
      },
    ]);

    const r = await bloquearNovoLinkSeJaAgendado(q, {
      organizationId: ORG,
      contactId: CONTATO,
      body: "Escolha um horário aqui: https://calendar.app.google/exemplo",
      now: AGORA,
    });

    expect(r?.code).toBe("agenda_ja_existente");
    expect(r?.message).toContain("05/10/2026");
    expect(r?.message).toContain("10:00");
    expect(r?.message).toContain("https://meet.google.com/abc-defg-hij");
    expect(r?.message).toMatch(/manter, remarcar ou cancelar/i);
    expect(r?.message).toMatch(/NÃO envie outro link/i);
  });

  it("⭐ filtra pela organização, pelo contato, pelo futuro e pelas situações vivas", async () => {
    const { q, chamadas } = db();
    await bloquearNovoLinkSeJaAgendado(q, {
      organizationId: ORG,
      contactId: CONTATO,
      body: "https://calendar.app.google/exemplo",
      now: AGORA,
    });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.sql).toContain("organization_id = $1");
    expect(chamadas[0]!.sql).toContain("contact_id = $2");
    expect(chamadas[0]!.sql).toContain("ends_at >= $3");
    expect(chamadas[0]!.sql).toContain("status = any($4::text[])");
    expect(chamadas[0]!.params[0]).toBe(ORG);
    expect(chamadas[0]!.params[1]).toBe(CONTATO);
    expect(chamadas[0]!.params[3]).toEqual(["pending", "confirmed"]);
  });

  it("sem compromisso ativo, o link continua saindo como hoje", async () => {
    const { q } = db([]);
    const r = await bloquearNovoLinkSeJaAgendado(q, {
      organizationId: ORG,
      contactId: CONTATO,
      body: "https://calendar.app.google/exemplo",
      now: AGORA,
    });
    expect(r).toBeNull();
  });

  it("perguntar ou reenviar o Meet não é bloqueado", async () => {
    const { q, chamadas } = db([
      {
        starts_at: "2026-10-05T13:00:00.000Z",
        time_zone: "America/Sao_Paulo",
        meeting_url: "https://meet.google.com/abc-defg-hij",
      },
    ]);

    const r = await bloquearNovoLinkSeJaAgendado(q, {
      organizationId: ORG,
      contactId: CONTATO,
      body: "Seu link é https://meet.google.com/abc-defg-hij",
      now: AGORA,
    });

    expect(r).toBeNull();
    expect(chamadas).toHaveLength(0);
  });
});
