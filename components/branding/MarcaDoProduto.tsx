import { LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";
import { cn } from "@/lib/utils";

/**
 * A marca do PRODUTO desenhada em SVG inline — o que a tela mostra quando
 * ninguém configurou marca própria (`marcaEhADoProduto`, em `lib/branding.ts`).
 *
 * Inline, e não `<img src="/algo.svg">`, por três motivos:
 *  - as cores seguem o TEMA e a paleta oficial do RenatoCRM — laranja de
 *    destaque, azul de apoio e neutros escuro/claro; um arquivo estático teria
 *    uma cor só;
 *  - nada em `public/`: um `.svg` fixo ali seria servido na instalação de um
 *    revendedor que configurou a marca dele (ver `lib/branding/desenho.ts`);
 *  - a barra lateral já usa `<img>` para o logo CONFIGURADO, e o e2e
 *    `marca-logo.spec.ts` mede "barra sem `<img>`" como "sem logo do
 *    revendedor". Um `<img>` do produto ali faria a spec medir a coisa errada.
 *
 * O texto alternativo é o `nome` que a tela já resolveu — nunca uma string
 * fixa, para que a catraca de marca (`tests/unit/branding.test.ts`) continue
 * contando ZERO ocorrências fora de `lib/branding.ts`.
 */

type TemaDaMarca = "auto" | "claro" | "escuro";

type Props = {
  readonly nome: string;
  readonly className?: string;
  /** `true` quando o texto ao lado já nomeia a marca — evita ler duas vezes. */
  readonly decorativo?: boolean;
  /** Força a paleta em prévias claro/escuro exibidas lado a lado. */
  readonly tema?: TemaDaMarca;
};

const SIMBOLO_CLARO_ESCURO = "fill-[#007a66] dark:fill-[#00a884]";
const NOME_CLARO_ESCURO = "fill-[#111b21] dark:fill-[#e9edef]";
const SUFIXO_CLARO_ESCURO = "fill-[#54656f] dark:fill-[#8696a0]";

const CORES_FIXAS = {
  claro: {
    simbolo: "fill-[#007a66]",
    nome: "fill-[#111b21]",
    sufixo: "fill-[#54656f]",
  },
  escuro: {
    simbolo: "fill-[#00a884]",
    nome: "fill-[#e9edef]",
    sufixo: "fill-[#8696a0]",
  },
} as const;

function classesDeCor(tema: TemaDaMarca) {
  if (tema === "claro") return CORES_FIXAS.claro;
  if (tema === "escuro") return CORES_FIXAS.escuro;
  return {
    simbolo: SIMBOLO_CLARO_ESCURO,
    nome: NOME_CLARO_ESCURO,
    sufixo: SUFIXO_CLARO_ESCURO,
  };
}

// As classes acima repetem os hexes de `CORES_DA_MARCA` porque o Tailwind só
// gera utilitário para valor LITERAL no fonte. Quem impede os dois de divergirem
// é `tests/unit/marca-do-produto.test.tsx`, que compara as classes à paleta —
// e não uma asserção em runtime: um throw aqui derrubaria a casca inteira.
export const CLASSES_DE_COR = {
  simbolo: SIMBOLO_CLARO_ESCURO,
  nome: NOME_CLARO_ESCURO,
  sufixo: SUFIXO_CLARO_ESCURO,
} as const;

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** O símbolo sozinho — para a barra recolhida, avatar e cantos apertados. */
export function SimboloDoProduto({
  nome,
  className,
  decorativo = false,
  tema = "auto",
}: Props) {
  const cores = classesDeCor(tema);
  return (
    <svg
      viewBox={SIMBOLO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <g className={cores.simbolo} transform={SIMBOLO.transform}>
        <path d={SIMBOLO.d} />
        <rect {...SIMBOLO.modulo} />
      </g>
    </svg>
  );
}

/** Símbolo + nome — para a barra aberta e a fachada de entrada. */
export function LogotipoDoProduto({
  nome,
  className,
  decorativo = false,
  tema = "auto",
}: Props) {
  const cores = classesDeCor(tema);
  return (
    <svg
      viewBox={LOGOTIPO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <g className={cores.simbolo} transform={LOGOTIPO.simbolo.transform}>
        <path d={LOGOTIPO.simbolo.d} />
        <rect {...LOGOTIPO.simbolo.modulo} />
      </g>
      <g className={cores.nome}>
        {LOGOTIPO.nome.map((g) => (
          <path key={g.transform} transform={g.transform} d={g.d} />
        ))}
      </g>
      <g className={cores.sufixo}>
        {LOGOTIPO.sufixo.map((g) => (
          <path key={g.transform} transform={g.transform} d={g.d} />
        ))}
      </g>
    </svg>
  );
}
