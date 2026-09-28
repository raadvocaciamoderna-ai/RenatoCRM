"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";

type Conta = { id: string; name: string };
type Plano = { id: string; name: string; direction: "in" | "out" };

type Cobranca = {
  id: string;
  asaas_payment_id: string | null;
  billing_type: "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";
  amount_cents: number;
  due_date: string;
  description: string | null;
  status: string;
  invoice_url: string | null;
  needs_reconciliation: boolean;
  created_at: string;
};

type Criacao = {
  local_payment_id: string;
  payment: {
    id: string;
    status: string;
    value: number;
    dueDate: string;
    invoiceUrl?: string | null;
  };
  pix: {
    encodedImage: string;
    payload: string;
    expirationDate: string;
  } | null;
  pix_error: string | null;
};

const STATUS: Record<string, string> = {
  CREATING: "Criando",
  CREATE_FAILED: "Falha ao criar",
  PENDING: "Pendente",
  CONFIRMED: "Confirmado",
  RECEIVED: "Recebido",
  OVERDUE: "Vencido",
  REFUNDED: "Estornado",
  REFUND_REQUESTED: "Estorno solicitado",
  CHARGEBACK_REQUESTED: "Chargeback solicitado",
};

const TIPO: Record<Cobranca["billing_type"], string> = {
  PIX: "Pix",
  BOLETO: "Boleto",
  CREDIT_CARD: "Cartão",
  UNDEFINED: "A definir",
};

function centavos(valor: string): number {
  const limpo = valor.trim();
  if (!limpo) return 0;
  const normalizado = limpo.includes(",")
    ? limpo.replace(/\./g, "").replace(",", ".")
    : limpo;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? Math.round(numero * 100) : 0;
}

function dinheiro(valor: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(valor / 100);
}

export function Pagamentos({ podeCobrar }: { podeCobrar: boolean }) {
  const qc = useQueryClient();

  const [nome, setNome] = useState("");
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [email, setEmail] = useState("");
  const [telefone, setTelefone] = useState("");
  const [valor, setValor] = useState("");
  const [vencimento, setVencimento] = useState("");
  const [descricao, setDescricao] = useState("");
  const [tipo, setTipo] = useState<Cobranca["billing_type"]>("PIX");
  const [contaId, setContaId] = useState("");
  const [planoId, setPlanoId] = useState("");
  const [criada, setCriada] = useState<Criacao | null>(null);
  const [copiado, setCopiado] = useState(false);

  const contas = useQuery({
    queryKey: ["financeiro", "catalogo", "contas"],
    queryFn: async () =>
      (await apiClient.get<{ data: Conta[] }>("/api/v1/financeiro/catalogo/contas")).data,
  });

  const planos = useQuery({
    queryKey: ["financeiro", "catalogo", "planos_de_conta"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Plano[] }>(
          "/api/v1/financeiro/catalogo/planos_de_conta",
        )
      ).data,
  });

  const cobrancas = useQuery({
    queryKey: ["financeiro", "asaas", "cobrancas"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Cobranca[] }>(
          "/api/v1/financeiro/asaas/cobrancas?limit=50",
        )
      ).data,
  });

  const planosEntrada = useMemo(
    () => (planos.data ?? []).filter((p) => p.direction === "in"),
    [planos.data],
  );

  const valorCentavos = centavos(valor);
  const documentoValido = [11, 14].includes(cpfCnpj.replace(/\D/g, "").length);
  const podeEnviar =
    podeCobrar &&
    nome.trim().length >= 2 &&
    documentoValido &&
    valorCentavos > 0 &&
    !!vencimento &&
    !!contaId;

  const criar = useMutation({
    mutationFn: async () => {
      const cliente = await apiClient.post<{
        data: { customer: { id: string }; created: boolean };
      }>("/api/v1/financeiro/asaas/clientes", {
        name: nome.trim(),
        cpfCnpj,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(telefone.trim() ? { mobilePhone: telefone.trim() } : {}),
      });

      const cobranca = await apiClient.post<{ data: Criacao }>(
        "/api/v1/financeiro/asaas/cobrancas",
        {
          customer_id: cliente.data.customer.id,
          billing_type: tipo,
          value_cents: valorCentavos,
          due_date: vencimento,
          ...(descricao.trim() ? { description: descricao.trim() } : {}),
          account_id: contaId,
          ...(planoId ? { account_plan_id: planoId } : {}),
        },
      );

      return cobranca.data;
    },
    onSuccess: (data) => {
      setCriada(data);
      setCopiado(false);
      void qc.invalidateQueries({ queryKey: ["financeiro", "asaas", "cobrancas"] });
    },
    onError: showApiError,
  });

  async function copiarPix() {
    if (!criada?.pix?.payload) return;
    await navigator.clipboard.writeText(criada.pix.payload);
    setCopiado(true);
  }

  return (
    <div className="space-y-4">
      {podeCobrar ? (
        <section className="space-y-4 rounded-xl border p-4">
          <div>
            <h2 className="font-semibold">Nova cobrança</h2>
            <p className="text-sm text-text-muted">
              O cliente é localizado ou criado no Asaas e a cobrança fica vinculada ao financeiro.
            </p>
          </div>

          {(contas.data?.length ?? 0) === 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm">
              Cadastre primeiro uma conta financeira para receber os pagamentos.{" "}
              <Link className="font-medium underline" href="/app/settings/tenant/financeiro">
                Abrir configurações financeiras
              </Link>
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span>Nome do cliente</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Ex.: Maria da Silva"
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>CPF/CNPJ</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={cpfCnpj}
                onChange={(e) => setCpfCnpj(e.target.value)}
                inputMode="numeric"
                placeholder="Somente números ou formatado"
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>E-mail do cliente</span>
              <input
                type="email"
                className="min-h-11 w-full rounded-md border p-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Opcional"
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Telefone</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
                inputMode="tel"
                placeholder="Opcional"
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Valor</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                inputMode="decimal"
                placeholder="Ex.: 10,00"
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Vencimento</span>
              <input
                type="date"
                className="min-h-11 w-full rounded-md border p-2"
                value={vencimento}
                onChange={(e) => setVencimento(e.target.value)}
              />
            </label>

            <label className="space-y-1 text-sm">
              <span>Forma de cobrança</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={tipo}
                onChange={(e) => setTipo(e.target.value as Cobranca["billing_type"])}
              >
                <option value="PIX">Pix</option>
                <option value="BOLETO">Boleto</option>
                <option value="CREDIT_CARD">Cartão</option>
                <option value="UNDEFINED">Cliente escolhe</option>
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span>Conta financeira</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={contaId}
                onChange={(e) => setContaId(e.target.value)}
              >
                <option value="">Selecione</option>
                {(contas.data ?? []).map((conta) => (
                  <option key={conta.id} value={conta.id}>
                    {conta.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm">
              <span>Plano de contas</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={planoId}
                onChange={(e) => setPlanoId(e.target.value)}
              >
                <option value="">Sem classificação</option>
                {planosEntrada.map((plano) => (
                  <option key={plano.id} value={plano.id}>
                    {plano.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block space-y-1 text-sm">
            <span>Descrição</span>
            <input
              className="min-h-11 w-full rounded-md border p-2"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Ex.: Honorários, consulta, parcela..."
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!podeEnviar || criar.isPending}
              onClick={() => criar.mutate()}
            >
              {criar.isPending ? "Gerando cobrança…" : "Gerar cobrança"}
            </Button>
            {valorCentavos > 0 ? (
              <span className="text-sm text-text-muted">{dinheiro(valorCentavos)}</span>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="rounded-xl border p-4 text-sm text-text-muted">
          Seu perfil pode consultar cobranças, mas não criar novas.
        </section>
      )}

      {criada ? (
        <section className="space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="font-semibold">Cobrança criada</h2>
            <p className="text-sm text-text-muted">
              Status no Asaas: {STATUS[criada.payment.status] ?? criada.payment.status}
            </p>
          </div>

          {criada.pix ? (
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="rounded-lg border bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${criada.pix.encodedImage}`}
                  alt="QR Code Pix"
                  className="h-auto w-full"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Pix copia e cola</p>
                <textarea
                  readOnly
                  className="min-h-28 w-full rounded-md border p-2 text-xs"
                  value={criada.pix.payload}
                />
                <Button variant="ghost" onClick={() => void copiarPix()}>
                  {copiado ? "Copiado" : "Copiar código Pix"}
                </Button>
              </div>
            </div>
          ) : null}

          {criada.pix_error ? (
            <p className="text-sm text-destructive">{criada.pix_error}</p>
          ) : null}

          {criada.payment.invoiceUrl ? (
            <a
              href={criada.payment.invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium underline"
            >
              Abrir cobrança no Asaas
            </a>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Cobranças recentes</h2>
            <p className="text-sm text-text-muted">
              O status é atualizado pelos webhooks do Asaas.
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={cobrancas.isFetching}
            onClick={() => void cobrancas.refetch()}
          >
            {cobrancas.isFetching ? "Atualizando…" : "Atualizar"}
          </Button>
        </div>

        {cobrancas.isLoading ? <p className="text-sm">Carregando…</p> : null}

        {!cobrancas.isLoading && (cobrancas.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-text-muted">Nenhuma cobrança criada pelo CRM ainda.</p>
        ) : null}

        <div className="space-y-2">
          {(cobrancas.data ?? []).map((cobranca) => (
            <article
              key={cobranca.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {dinheiro(cobranca.amount_cents)} · {TIPO[cobranca.billing_type]}
                </p>
                <p className="text-sm text-text-muted">
                  {cobranca.description || "Sem descrição"} · vence em {cobranca.due_date}
                </p>
                {cobranca.needs_reconciliation ? (
                  <p className="text-xs text-warning-fg">Precisa de conferência manual</p>
                ) : null}
              </div>
              <div className="text-right">
                <p className="text-sm font-medium">{STATUS[cobranca.status] ?? cobranca.status}</p>
                {cobranca.invoice_url ? (
                  <a
                    href={cobranca.invoice_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline"
                  >
                    Abrir cobrança
                  </a>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
