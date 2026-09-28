"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";

type Conta = { id: string; name: string };
type Plano = { id: string; name: string; direction: "in" | "out" };

type ContactSummary = {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
};

type ContactDetail = ContactSummary & {
  cpf_decrypted?: string | null;
  cpf_available?: boolean;
  cpf_decrypt_denied?: boolean;
};

type Cobranca = {
  id: string;
  contact_id: string | null;
  asaas_payment_id: string | null;
  installment_id: string | null;
  subscription_id: string | null;
  installment_number: number | null;
  billing_type: "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";
  amount_cents: number;
  due_date: string;
  description: string | null;
  status: string;
  invoice_url: string | null;
  needs_reconciliation: boolean;
  created_at: string;
};

type Assinatura = {
  id: string;
  contact_id: string | null;
  asaas_subscription_id: string;
  billing_type: Cobranca["billing_type"];
  amount_cents: number;
  cycle: Cycle;
  next_due_date: string;
  description: string | null;
  max_payments: number | null;
  status: string;
  created_at: string;
};

type Pix = {
  encodedImage: string;
  payload: string;
  expirationDate: string;
};

type PagamentoRemoto = {
  id: string;
  status: string;
  value: number;
  dueDate: string;
  invoiceUrl?: string | null;
};

type ResultadoCriacao =
  | {
      kind: "single";
      title: string;
      payment: PagamentoRemoto;
      pix: Pix | null;
      pix_error: string | null;
    }
  | {
      kind: "installment";
      title: string;
      payment: PagamentoRemoto | null;
      pix: Pix | null;
      count: number;
    }
  | {
      kind: "subscription";
      title: string;
      payment: PagamentoRemoto | null;
      pix: Pix | null;
      subscriptionId: string;
    };

type Modo = "single" | "installment" | "subscription";
type Cycle =
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "BIMONTHLY"
  | "QUARTERLY"
  | "SEMIANNUALLY"
  | "YEARLY";

const STATUS: Record<string, string> = {
  CREATING: "Criando",
  CREATE_FAILED: "Falha ao criar",
  PENDING: "Pendente",
  CONFIRMED: "Confirmado",
  RECEIVED: "Pago",
  OVERDUE: "Vencido",
  REFUNDED: "Estornado",
  REFUND_REQUESTED: "Estorno solicitado",
  CHARGEBACK_REQUESTED: "Chargeback solicitado",
};

const TIPO: Record<Cobranca["billing_type"], string> = {
  PIX: "Pix",
  BOLETO: "Boleto",
  CREDIT_CARD: "Cartão",
  UNDEFINED: "Cliente escolhe",
};

const CICLO: Record<Cycle, string> = {
  WEEKLY: "Semanal",
  BIWEEKLY: "Quinzenal",
  MONTHLY: "Mensal",
  BIMONTHLY: "Bimestral",
  QUARTERLY: "Trimestral",
  SEMIANNUALLY: "Semestral",
  YEARLY: "Anual",
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

function rotuloContato(c: ContactSummary): string {
  return c.name?.trim() || c.display_name?.trim() || c.phone_number || "Contato";
}

type Categoria = "all" | "pending" | "received" | "overdue" | "refunded";

function categoria(status: string): Exclude<Categoria, "all"> {
  if (status === "RECEIVED") return "received";
  if (status === "OVERDUE") return "overdue";
  if (status.includes("REFUND") || status.includes("CHARGEBACK")) return "refunded";
  return "pending";
}

export function Pagamentos({ podeCobrar }: { podeCobrar: boolean }) {
  const qc = useQueryClient();
  const params = useSearchParams();

  const [contactId, setContactId] = useState(params.get("contact_id") ?? "");
  const [buscaContato, setBuscaContato] = useState("");
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
  const [modo, setModo] = useState<Modo>("single");
  const [parcelas, setParcelas] = useState("2");
  const [cycle, setCycle] = useState<Cycle>("MONTHLY");
  const [maxPayments, setMaxPayments] = useState("");
  const [resultado, setResultado] = useState<ResultadoCriacao | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [filtro, setFiltro] = useState<Categoria>("all");
  const [filtroTipo, setFiltroTipo] = useState<"all" | Cobranca["billing_type"]>("all");
  const [mensagemAcao, setMensagemAcao] = useState<string | null>(null);

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
          "/api/v1/financeiro/asaas/cobrancas?limit=100",
        )
      ).data,
  });

  const assinaturas = useQuery({
    queryKey: ["financeiro", "asaas", "assinaturas"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Assinatura[] }>(
          "/api/v1/financeiro/asaas/assinaturas?limit=50",
        )
      ).data,
  });

  const contatos = useQuery({
    queryKey: ["pagamentos", "contatos", buscaContato],
    enabled: buscaContato.trim().length >= 2,
    queryFn: async () =>
      (
        await apiClient.get<{ data: ContactSummary[] }>(
          `/api/v1/contacts?search=${encodeURIComponent(buscaContato.trim())}&limit=8`,
        )
      ).data,
  });

  const contatoSelecionado = useQuery({
    queryKey: ["pagamentos", "contato", contactId],
    enabled: !!contactId,
    queryFn: async () =>
      (
        await apiClient.get<{ data: ContactDetail }>(
          `/api/v1/contacts/${encodeURIComponent(contactId)}`,
          { headers: { "X-Decrypt-Purpose": "Gerar cobrança pelo Asaas" } },
        )
      ).data,
  });

  useEffect(() => {
    const contact = contatoSelecionado.data;
    if (!contact) return;
    setNome(contact.name?.trim() || contact.display_name?.trim() || "");
    setEmail(contact.email ?? "");
    setTelefone(contact.phone_number ?? "");
    if (contact.cpf_decrypted) setCpfCnpj(contact.cpf_decrypted);
  }, [contatoSelecionado.data]);

  const planosEntrada = useMemo(
    () => (planos.data ?? []).filter((p) => p.direction === "in"),
    [planos.data],
  );

  const valorCentavos = centavos(valor);
  const documentoValido = [11, 14].includes(cpfCnpj.replace(/\D/g, "").length);
  const numeroParcelas = Number(parcelas);
  const numeroMaxPayments = maxPayments.trim() ? Number(maxPayments) : undefined;

  const podeEnviar =
    podeCobrar &&
    nome.trim().length >= 2 &&
    documentoValido &&
    valorCentavos > 0 &&
    !!vencimento &&
    !!contaId &&
    (modo !== "installment" ||
      (Number.isInteger(numeroParcelas) && numeroParcelas >= 2 && numeroParcelas <= 24)) &&
    (modo !== "subscription" ||
      numeroMaxPayments === undefined ||
      (Number.isInteger(numeroMaxPayments) && numeroMaxPayments >= 1));

  const criar = useMutation({
    mutationFn: async (): Promise<ResultadoCriacao> => {
      const cliente = await apiClient.post<{
        data: { customer: { id: string }; created: boolean };
      }>("/api/v1/financeiro/asaas/clientes", {
        name: nome.trim(),
        cpfCnpj,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(telefone.trim() ? { mobilePhone: telefone.trim() } : {}),
        ...(contactId ? { contact_id: contactId } : {}),
      });

      const base = {
        customer_id: cliente.data.customer.id,
        ...(contactId ? { contact_id: contactId } : {}),
        billing_type: tipo,
        description: descricao.trim() || undefined,
        account_id: contaId,
        account_plan_id: planoId || undefined,
      };

      if (modo === "installment") {
        const result = await apiClient.post<{
          data: {
            payments: PagamentoRemoto[];
            pix: Pix | null;
          };
        }>("/api/v1/financeiro/asaas/parcelamentos", {
          ...base,
          total_value_cents: valorCentavos,
          installment_count: numeroParcelas,
          due_date: vencimento,
        });
        return {
          kind: "installment",
          title: `Parcelamento em ${numeroParcelas}x criado`,
          payment: result.data.payments[0] ?? null,
          pix: result.data.pix,
          count: numeroParcelas,
        };
      }

      if (modo === "subscription") {
        const result = await apiClient.post<{
          data: {
            subscription: { id: string };
            payments: PagamentoRemoto[];
            pix: Pix | null;
          };
        }>("/api/v1/financeiro/asaas/assinaturas", {
          ...base,
          value_cents: valorCentavos,
          next_due_date: vencimento,
          cycle,
          ...(numeroMaxPayments ? { max_payments: numeroMaxPayments } : {}),
        });
        return {
          kind: "subscription",
          title: `Recorrência ${CICLO[cycle].toLowerCase()} criada`,
          payment: result.data.payments[0] ?? null,
          pix: result.data.pix,
          subscriptionId: result.data.subscription.id,
        };
      }

      const result = await apiClient.post<{
        data: {
          payment: PagamentoRemoto;
          pix: Pix | null;
          pix_error: string | null;
        };
      }>("/api/v1/financeiro/asaas/cobrancas", {
        ...base,
        value_cents: valorCentavos,
        due_date: vencimento,
      });
      return {
        kind: "single",
        title: "Cobrança criada",
        payment: result.data.payment,
        pix: result.data.pix,
        pix_error: result.data.pix_error,
      };
    },
    onSuccess: (data) => {
      setResultado(data);
      setCopiado(false);
      setMensagemAcao(null);
      void qc.invalidateQueries({ queryKey: ["financeiro", "asaas", "cobrancas"] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "asaas", "assinaturas"] });
    },
    onError: showApiError,
  });

  const enviarWhatsApp = useMutation({
    mutationFn: async (paymentId: string) =>
      (
        await apiClient.post<{ data: { sent: boolean } }>(
          "/api/v1/financeiro/asaas/cobrancas/enviar-whatsapp",
          { payment_id: paymentId },
        )
      ).data,
    onSuccess: () => setMensagemAcao("Cobrança enviada pelo WhatsApp."),
    onError: showApiError,
  });

  const copiarPixExistente = useMutation({
    mutationFn: async (paymentId: string) => {
      const pix = (
        await apiClient.get<{ data: Pix }>(
          `/api/v1/financeiro/asaas/cobrancas/${encodeURIComponent(paymentId)}/pix`,
        )
      ).data;
      await navigator.clipboard.writeText(pix.payload);
      return paymentId;
    },
    onSuccess: () => setMensagemAcao("Código Pix copiado."),
    onError: showApiError,
  });

  async function copiarPixNovo() {
    if (!resultado?.pix?.payload) return;
    await navigator.clipboard.writeText(resultado.pix.payload);
    setCopiado(true);
  }

  function escolherContato(contact: ContactSummary) {
    setContactId(contact.id);
    setBuscaContato("");
    setNome(contact.name?.trim() || contact.display_name?.trim() || "");
    setEmail(contact.email ?? "");
    setTelefone(contact.phone_number ?? "");
    setCpfCnpj("");
  }

  function limparContato() {
    setContactId("");
    setNome("");
    setCpfCnpj("");
    setEmail("");
    setTelefone("");
  }

  const totais = useMemo(() => {
    const base = cobrancas.data ?? [];
    return {
      receber: base
        .filter((p) => categoria(p.status) === "pending" || categoria(p.status) === "overdue")
        .reduce((sum, p) => sum + Number(p.amount_cents), 0),
      recebido: base
        .filter((p) => categoria(p.status) === "received")
        .reduce((sum, p) => sum + Number(p.amount_cents), 0),
      vencido: base
        .filter((p) => categoria(p.status) === "overdue")
        .reduce((sum, p) => sum + Number(p.amount_cents), 0),
    };
  }, [cobrancas.data]);

  const filtradas = useMemo(
    () =>
      (cobrancas.data ?? []).filter(
        (p) =>
          (filtro === "all" || categoria(p.status) === filtro) &&
          (filtroTipo === "all" || p.billing_type === filtroTipo),
      ),
    [cobrancas.data, filtro, filtroTipo],
  );

  const firstPayment = resultado?.payment ?? null;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border p-4">
          <p className="text-xs uppercase text-text-muted">A receber</p>
          <p className="mt-1 text-xl font-semibold">{dinheiro(totais.receber)}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-xs uppercase text-text-muted">Recebido</p>
          <p className="mt-1 text-xl font-semibold">{dinheiro(totais.recebido)}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-xs uppercase text-text-muted">Vencido</p>
          <p className="mt-1 text-xl font-semibold">{dinheiro(totais.vencido)}</p>
        </div>
      </section>

      {podeCobrar ? (
        <section className="space-y-4 rounded-xl border p-4">
          <div>
            <h2 className="font-semibold">Nova cobrança</h2>
            <p className="text-sm text-text-muted">
              Avulsa, parcelada ou recorrente. O recebimento entra no financeiro somente após o webhook do Asaas.
            </p>
          </div>

          {(contas.data?.length ?? 0) === 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm">
              Cadastre primeiro uma conta financeira.{" "}
              <Link className="font-medium underline" href="/app/settings/tenant/financeiro">
                Abrir configurações financeiras
              </Link>
            </div>
          ) : null}

          <div className="space-y-2">
            <label className="block text-sm font-medium">Contato do CRM</label>
            {contactId && contatoSelecionado.data ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
                <Link
                  href={`/app/contacts/${contactId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {rotuloContato(contatoSelecionado.data)}
                </Link>
                <span className="text-sm text-text-muted">
                  {contatoSelecionado.data.phone_number ?? ""}
                </span>
                <Button variant="ghost" onClick={limparContato}>
                  Trocar contato
                </Button>
              </div>
            ) : (
              <div className="relative max-w-xl">
                <input
                  className="min-h-11 w-full rounded-md border p-2"
                  value={buscaContato}
                  onChange={(e) => setBuscaContato(e.target.value)}
                  placeholder="Busque pelo nome, telefone ou e-mail"
                />
                {buscaContato.trim().length >= 2 ? (
                  <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-card shadow-lg">
                    {(contatos.data ?? []).map((contact) => (
                      <button
                        key={contact.id}
                        type="button"
                        onClick={() => escolherContato(contact)}
                        className="block w-full border-b p-3 text-left last:border-b-0 hover:bg-accent/50"
                      >
                        <span className="block font-medium">{rotuloContato(contact)}</span>
                        <span className="block text-xs text-text-muted">
                          {[contact.phone_number, contact.email].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    ))}
                    {!contatos.isLoading && (contatos.data?.length ?? 0) === 0 ? (
                      <p className="p-3 text-sm text-text-muted">Nenhum contato encontrado.</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            {contactId &&
            contatoSelecionado.data?.cpf_available &&
            !contatoSelecionado.data.cpf_decrypted ? (
              <p className="text-xs text-text-muted">
                O contato possui CPF/CNPJ cadastrado, mas seu perfil não pode descriptografá-lo. Informe o documento abaixo para gerar a cobrança.
              </p>
            ) : null}
          </div>

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
                placeholder="CPF ou CNPJ"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>E-mail</span>
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
              <span>Tipo de cobrança</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={modo}
                onChange={(e) => setModo(e.target.value as Modo)}
              >
                <option value="single">Avulsa</option>
                <option value="installment">Parcelada</option>
                <option value="subscription">Recorrente / mensalidade</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>Valor {modo === "installment" ? "total" : ""}</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                inputMode="decimal"
                placeholder="Ex.: 150,00"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{modo === "subscription" ? "Primeiro vencimento" : "Vencimento"}</span>
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

            {modo === "installment" ? (
              <label className="space-y-1 text-sm">
                <span>Número de parcelas</span>
                <input
                  className="min-h-11 w-full rounded-md border p-2"
                  value={parcelas}
                  onChange={(e) => setParcelas(e.target.value)}
                  inputMode="numeric"
                  min={2}
                  max={24}
                />
              </label>
            ) : null}

            {modo === "subscription" ? (
              <>
                <label className="space-y-1 text-sm">
                  <span>Periodicidade</span>
                  <select
                    className="min-h-11 w-full rounded-md border p-2"
                    value={cycle}
                    onChange={(e) => setCycle(e.target.value as Cycle)}
                  >
                    {Object.entries(CICLO).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span>Quantidade máxima</span>
                  <input
                    className="min-h-11 w-full rounded-md border p-2"
                    value={maxPayments}
                    onChange={(e) => setMaxPayments(e.target.value)}
                    inputMode="numeric"
                    placeholder="Vazio = sem limite"
                  />
                </label>
              </>
            ) : null}

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
              placeholder="Ex.: Honorários, consulta, mensalidade..."
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!podeEnviar || criar.isPending} onClick={() => criar.mutate()}>
              {criar.isPending ? "Gerando…" : "Gerar cobrança"}
            </Button>
            {valorCentavos > 0 ? (
              <span className="text-sm text-text-muted">
                {dinheiro(valorCentavos)}
                {modo === "installment" && numeroParcelas >= 2
                  ? ` em ${numeroParcelas}x`
                  : ""}
              </span>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="rounded-xl border p-4 text-sm text-text-muted">
          Seu perfil pode consultar cobranças, mas não criar novas.
        </section>
      )}

      {resultado ? (
        <section className="space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="font-semibold">{resultado.title}</h2>
            <p className="text-sm text-text-muted">
              {firstPayment
                ? `Primeira cobrança: ${STATUS[firstPayment.status] ?? firstPayment.status}`
                : "O Asaas criará as cobranças conforme o calendário configurado."}
            </p>
          </div>

          {resultado.pix ? (
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="rounded-lg border bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${resultado.pix.encodedImage}`}
                  alt="QR Code Pix"
                  className="h-auto w-full"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Pix copia e cola</p>
                <textarea
                  readOnly
                  className="min-h-28 w-full rounded-md border p-2 text-xs"
                  value={resultado.pix.payload}
                />
                <Button variant="ghost" onClick={() => void copiarPixNovo()}>
                  {copiado ? "Copiado" : "Copiar código Pix"}
                </Button>
              </div>
            </div>
          ) : null}

          {resultado.kind === "single" && resultado.pix_error ? (
            <p className="text-sm text-destructive">{resultado.pix_error}</p>
          ) : null}

          {firstPayment?.invoiceUrl ? (
            <a
              href={firstPayment.invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium underline"
            >
              Abrir primeira cobrança
            </a>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Cobranças</h2>
            <p className="text-sm text-text-muted">
              Status atualizado pelos webhooks do Asaas.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Filtrar por status"
              className="min-h-11 rounded-md border p-2 text-sm"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value as Categoria)}
            >
              <option value="all">Todos os status</option>
              <option value="pending">Pendentes</option>
              <option value="received">Pagos</option>
              <option value="overdue">Vencidos</option>
              <option value="refunded">Estornados</option>
            </select>
            <select
              aria-label="Filtrar por forma de pagamento"
              className="min-h-11 rounded-md border p-2 text-sm"
              value={filtroTipo}
              onChange={(e) =>
                setFiltroTipo(e.target.value as "all" | Cobranca["billing_type"])
              }
            >
              <option value="all">Todas as formas</option>
              <option value="PIX">Pix</option>
              <option value="BOLETO">Boleto</option>
              <option value="CREDIT_CARD">Cartão</option>
              <option value="UNDEFINED">Cliente escolhe</option>
            </select>
            <Button
              variant="ghost"
              disabled={cobrancas.isFetching}
              onClick={() => void cobrancas.refetch()}
            >
              {cobrancas.isFetching ? "Atualizando…" : "Atualizar"}
            </Button>
          </div>
        </div>

        {mensagemAcao ? (
          <p role="status" className="text-sm text-text-muted">
            {mensagemAcao}
          </p>
        ) : null}

        {cobrancas.isLoading ? <p className="text-sm">Carregando…</p> : null}

        {!cobrancas.isLoading && filtradas.length === 0 ? (
          <p className="text-sm text-text-muted">Nenhuma cobrança neste filtro.</p>
        ) : null}

        <div className="space-y-2">
          {filtradas.map((cobranca) => (
            <article
              key={cobranca.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {dinheiro(Number(cobranca.amount_cents))} · {TIPO[cobranca.billing_type]}
                  {cobranca.installment_number ? ` · parcela ${cobranca.installment_number}` : ""}
                </p>
                <p className="text-sm text-text-muted">
                  {cobranca.description || "Sem descrição"} · vence em {cobranca.due_date}
                </p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {cobranca.contact_id ? (
                    <Link className="underline" href={`/app/contacts/${cobranca.contact_id}`}>
                      Abrir contato
                    </Link>
                  ) : null}
                  {cobranca.installment_id ? <span>Parcelamento</span> : null}
                  {cobranca.subscription_id ? <span>Recorrente</span> : null}
                  {cobranca.needs_reconciliation ? (
                    <span className="text-warning-fg">Precisa de conferência manual</span>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-sm font-medium">
                  {STATUS[cobranca.status] ?? cobranca.status}
                </span>
                {cobranca.invoice_url ? (
                  <a
                    href={cobranca.invoice_url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border px-3 py-2 text-xs font-medium"
                  >
                    Segunda via
                  </a>
                ) : null}
                {cobranca.billing_type === "PIX" && cobranca.asaas_payment_id ? (
                  <Button
                    variant="ghost"
                    disabled={copiarPixExistente.isPending}
                    onClick={() => copiarPixExistente.mutate(cobranca.id)}
                  >
                    Copiar Pix
                  </Button>
                ) : null}
                {cobranca.contact_id && cobranca.invoice_url && podeCobrar ? (
                  <Button
                    variant="ghost"
                    disabled={enviarWhatsApp.isPending}
                    onClick={() => enviarWhatsApp.mutate(cobranca.id)}
                  >
                    Enviar WhatsApp
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div>
          <h2 className="font-semibold">Recorrências / mensalidades</h2>
          <p className="text-sm text-text-muted">
            O Asaas gera novas cobranças automaticamente conforme a periodicidade.
          </p>
        </div>
        {assinaturas.isLoading ? <p className="text-sm">Carregando…</p> : null}
        {!assinaturas.isLoading && (assinaturas.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-text-muted">Nenhuma recorrência criada.</p>
        ) : null}
        <div className="space-y-2">
          {(assinaturas.data ?? []).map((assinatura) => (
            <div
              key={assinatura.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <p className="font-medium">
                  {assinatura.description || "Mensalidade"} · {dinheiro(Number(assinatura.amount_cents))}
                </p>
                <p className="text-sm text-text-muted">
                  {CICLO[assinatura.cycle]} · próximo vencimento {assinatura.next_due_date}
                  {assinatura.max_payments ? ` · até ${assinatura.max_payments} cobranças` : ""}
                </p>
              </div>
              <span className="text-sm font-medium">{assinatura.status}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
