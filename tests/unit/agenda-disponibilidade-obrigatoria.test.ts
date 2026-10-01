import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { pedidoDeDisponibilidadeAgenda } from "@/lib/agent-engine/agent/agenda-disponibilidade";

describe("pedidoDeDisponibilidadeAgenda", () => {
  it.each([
    "Quais dias e horários disponíveis",
    "Quais horários tem?",
    "Horários disponíveis",
    "Quando vocês têm vaga?",
    "Tem algum horário?",
    "Quero marcar",
    "Quero agendar",
    "Quero uma reunião",
    "Próximos 3 dias",
    "próximos 7 dias",
    "Essa semana",
    "Semana que vem",
  ])("detecta pedido de disponibilidade: %s", (texto) => {
    expect(pedidoDeDisponibilidadeAgenda(texto)).toBe(true);
  });

  it.each([
    "Oi",
    "Bom dia",
    "Tenho uma dúvida sobre pensão por morte",
    "Meu benefício foi negado",
    "Quero falar sobre guarda",
  ])("não transforma conversa comum em consulta de agenda: %s", (texto) => {
    expect(pedidoDeDisponibilidadeAgenda(texto)).toBe(false);
  });
});

describe("fiação: disponibilidade não pode virar nova pergunta", () => {
  const fonte = fs.readFileSync(
    path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );

  it("send_message bloqueia resposta antes de crm_find_free_slots rodar", () => {
    const inicio = fonte.indexOf("send_message: tool({");
    const fim = fonte.indexOf("update_lead_state: tool({", inicio);
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const corpo = fonte.slice(inicio, fim);

    expect(corpo).toContain("pedidoDeDisponibilidadeAgenda(mensagemDoJob)");
    expect(corpo).toContain("!agendaToolCalledThisTurn");
    expect(corpo).toContain("crm_find_free_slots");
    expect(corpo).toContain("agenda_disponibilidade_sem_consulta");
    expect(corpo).toContain("próximos N dias");
  });
});
