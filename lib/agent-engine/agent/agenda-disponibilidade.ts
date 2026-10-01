/**
 * Detecta pedidos em que o cliente quer VER disponibilidade da agenda agora.
 *
 * Este sinal não decide horário nem marca nada. Ele só impede o Conversador de
 * responder com outra pergunta quando já há informação suficiente para consultar
 * a agenda. A consulta real continua nas tools, que aplicam jornada, ocupação,
 * calendário externo e fuso.
 */
export function pedidoDeDisponibilidadeAgenda(texto: string): boolean {
  const t = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (t === '') return false;

  return (
    /\bhorarios?\s+disponiveis?\b/.test(t) ||
    /\bquais?\s+(?:dias?\s+e\s+)?horarios?\b/.test(t) ||
    /\bquando\s+(?:voces?\s+)?(?:tem|ha)\s+(?:vaga|horarios?)\b/.test(t) ||
    /\btem\s+(?:algum\s+)?horario\b/.test(t) ||
    /\bquero\s+(?:marcar|agendar|uma\s+reuniao|reuniao)\b/.test(t) ||
    /\bproximos?\s+\d+\s+dias?\b/.test(t) ||
    /\b(?:essa|esta)\s+semana\b/.test(t) ||
    /\bsemana\s+que\s+vem\b/.test(t)
  );
}
