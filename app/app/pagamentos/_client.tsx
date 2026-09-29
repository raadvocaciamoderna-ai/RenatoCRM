"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import {
  ArrowSquareOut,
  ChatCircle,
  CheckCircle,
  ClockCountdown,
  Receipt,
  Users,
  Warning,
  WhatsappLogo,
} from "@/lib/ui/icons";
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
  conversa?: {
    id: string;
    preview?: string | null;
    unread?: number;
  } | null;
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
  contact: ContactSummary | null;
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
  contact: ContactSummary | null;
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

function percentual(valor: string): number | undefined {
  const limpo = valor.trim().replace(",", ".");
  if (!limpo) return undefined;
  const numero = Number(limpo);
  return Number.isFinite(numero) && numero > 0 ? numero : undefined;
}

function rotuloContato(c: ContactSummary): string {
  return c.name?.trim() || c.display_name?.trim() || c.phone_number || "Contato";
}

type Categoria = "all" | "pending" | "received" | "overdue" | "refunded" | "failed";

function categoria(status: string): Exclude<Categoria, "all"> {
  if (status === "CREATE_FAILED") return "failed";
  if (status === "RECEIVED") return "received";
  if (status === "OVERDUE") return "overdue";
  if (status.includes("REFUND") || status.includes("CHARGEBACK")) return "refunded";
  return "pending";
}

function statusVariant(status: string): "success" | "warning" | "error" | "info" | "neutral" {
  const cat = categoria(status);
  if (cat === "received") return "success";
  if (cat === "overdue" || cat === "failed") return "error";
  if (cat === "pending") return "warning";
  if (cat === "refunded") return "neutral";
  return "info";
}

function dataBr(value: string): string {
  const [ano, mes, dia] = value.split("-");
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : value;
}

export function Pagamentos({ podeCobrar }: { podeCobrar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const params = useSearchParams();

  const contactIdInicial = params.get("contact_id") ?? "";
  const [origemCliente, setOrigemCliente] = useState<"crm" | "manual">("crm");
  const [contactId, setContactId] = useState(contactIdInicial);
  const [buscaContato, setBuscaContato] = useState("");
  const [novoContatoOpen, setNovoContatoOpen] = useState(false);
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
  const [juros, setJuros] = useState("");
  const [multa, setMulta] = useState("");
  const [desconto, setDesconto] = useState("");
  const [descontoDias, setDescontoDias] = useState("0");
  const [parcelamentosAbertos, setParcelamentosAbertos] = useState<string[]>([]);
  const [resultado, setResultado] = useState<ResultadoCriacao | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [filtro, setFiltro] = useState<Categoria>("all");
  const [filtroTipo, setFiltroTipo] = useState<"all" | Cobranca["billing_type"]>("all");
  const [mensagemAcao, setMensagemAcao] = useState<string | null>(null);
  const [conversaEnviadaId, setConversaEnviadaId] = useState<string | null>(null);

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
  const jurosPercentual = percentual(juros);
  const multaPercentual = percentual(multa);
  const descontoPercentual = percentual(desconto);
  const diasDesconto = Math.max(0, Number.parseInt(descontoDias || "0", 10) || 0);

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
      (Number.isInteger(numeroMaxPayments) &&
        numeroMaxPayments >= 1 &&
        numeroMaxPayments <= 240));

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
        ...(jurosPercentual
          ? { interest: { value: jurosPercentual, type: "PERCENTAGE" as const } }
          : {}),
        ...(multaPercentual
          ? { fine: { value: multaPercentual, type: "PERCENTAGE" as const } }
          : {}),
        ...(descontoPercentual
          ? {
              discount: {
                value: descontoPercentual,
                type: "PERCENTAGE" as const,
                dueDateLimitDays: diasDesconto,
              },
            }
          : {}),
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
          title: t("Parcelamento criado"),
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
          title: t("Recorrência criada"),
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
        title: t("Cobrança criada"),
        payment: result.data.payment,
        pix: result.data.pix,
        pix_error: result.data.pix_error,
      };
    },
    onSuccess: (data) => {
      setResultado(data);
      setCopiado(false);
      setMensagemAcao(null);
      setConversaEnviadaId(null);
      toast.success(t("Cobrança gerada com sucesso."));
      void qc.invalidateQueries({ queryKey: ["financeiro", "asaas", "cobrancas"] });
      void qc.invalidateQueries({ queryKey: ["financeiro", "asaas", "assinaturas"] });
    },
    onError: (error) => {
      showApiError(error);
    },
  });

  const enviarWhatsApp = useMutation({
    mutationFn: async (paymentId: string) =>
      (
        await apiClient.post<{
          data: { sent: boolean; conversation_id: string; message_id: string };
        }>(
          "/api/v1/financeiro/asaas/cobrancas/enviar-whatsapp",
          { payment_id: paymentId },
        )
      ).data,
    onSuccess: (data) => {
      setMensagemAcao(t("Cobrança enviada pelo WhatsApp."));
      setConversaEnviadaId(data.conversation_id);
    },
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
    onSuccess: () => setMensagemAcao(t("Código Pix copiado.")),
    onError: showApiError,
  });

  async function copiarPixNovo() {
    if (!resultado?.pix?.payload) return;
    await navigator.clipboard.writeText(resultado.pix.payload);
    setCopiado(true);
  }

  function escolherContato(contact: ContactSummary) {
    setOrigemCliente("crm");
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

  function mudarOrigemCliente(origem: "crm" | "manual") {
    if (origem === origemCliente) return;
    limparContato();
    setBuscaContato("");
    setOrigemCliente(origem);
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

  const gruposCobrancas = useMemo(() => {
    const grupos = new Map<string, Cobranca[]>();
    for (const cobranca of filtradas) {
      const chave = cobranca.installment_id ? `installment:${cobranca.installment_id}` : `payment:${cobranca.id}`;
      const atual = grupos.get(chave) ?? [];
      atual.push(cobranca);
      grupos.set(chave, atual);
    }
    return Array.from(grupos.entries()).map(([chave, itens]) => ({
      chave,
      itens: [...itens].sort(
        (a, b) => (a.installment_number ?? 0) - (b.installment_number ?? 0),
      ),
    }));
  }, [filtradas]);

  function alternarParcelamento(chave: string) {
    setParcelamentosAbertos((atuais) =>
      atuais.includes(chave) ? atuais.filter((item) => item !== chave) : [...atuais, chave],
    );
  }

  const firstPayment = resultado?.payment ?? null;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="overflow-hidden">
          <CardContent className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("A receber")}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{dinheiro(totais.receber)}</p>
            </div>
            <div className="rounded-full bg-info-bg p-3 text-info-fg">
              <ClockCountdown size={22} weight="duotone" aria-hidden />
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Recebido")}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{dinheiro(totais.recebido)}</p>
            </div>
            <div className="rounded-full bg-success-bg p-3 text-success-fg">
              <CheckCircle size={22} weight="duotone" aria-hidden />
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Vencido")}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{dinheiro(totais.vencido)}</p>
            </div>
            <div className="rounded-full bg-error-bg p-3 text-error-fg">
              <Warning size={22} weight="duotone" aria-hidden />
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardContent className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Recorrências / mensalidades")}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{assinaturas.data?.length ?? 0}</p>
            </div>
            <div className="rounded-full bg-accent-soft p-3 text-accent">
              <Receipt size={22} weight="duotone" aria-hidden />
            </div>
          </CardContent>
        </Card>
      </section>

      {podeCobrar ? (
        <Card className="overflow-visible">
          <CardHeader className="border-b border-border bg-surface-elevated/50">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-accent-soft p-2.5 text-accent">
                <Users size={20} weight="duotone" aria-hidden />
              </div>
              <div>
                <CardTitle>{t("Nova cobrança")}</CardTitle>
                <CardDescription>
                  {t("Avulsa, parcelada ou recorrente. O recebimento entra no financeiro somente após o webhook do Asaas.")}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-5">

          {(contas.data?.length ?? 0) === 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm">
              {t("Cadastre primeiro uma conta financeira.")}{" "}
              <Link className="font-medium underline" href="/app/settings/tenant/financeiro">
                {t("Abrir configurações financeiras")}
              </Link>
            </div>
          ) : null}

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">{t("Cliente da cobrança")}</p>
              <p className="mt-0.5 text-xs text-text-muted">
                {t("Use um contato já existente no CRM ou informe os dados manualmente.")}
              </p>
            </div>

            <div className="grid max-w-2xl grid-cols-2 gap-2 rounded-lg bg-surface-elevated p-1">
              <button
                type="button"
                onClick={() => mudarOrigemCliente("crm")}
                className={
                  origemCliente === "crm"
                    ? "rounded-md bg-surface px-3 py-2 text-sm font-medium text-text shadow-xs"
                    : "rounded-md px-3 py-2 text-sm text-text-muted transition-colors hover:text-text"
                }
              >
                {t("Selecionar no CRM")}
              </button>
              <button
                type="button"
                onClick={() => mudarOrigemCliente("manual")}
                className={
                  origemCliente === "manual"
                    ? "rounded-md bg-surface px-3 py-2 text-sm font-medium text-text shadow-xs"
                    : "rounded-md px-3 py-2 text-sm text-text-muted transition-colors hover:text-text"
                }
              >
                {t("Digitar manualmente")}
              </button>
            </div>

            {origemCliente === "crm" ? (
              contactId && contatoSelecionado.data ? (
                <div className="rounded-lg border border-border bg-surface-elevated/40 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="rounded-full bg-accent-soft p-2.5 text-accent">
                        <Users size={20} weight="duotone" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold">{rotuloContato(contatoSelecionado.data)}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-text-muted">
                          {contatoSelecionado.data.phone_number ? (
                            <span className="inline-flex items-center gap-1">
                              <WhatsappLogo size={15} aria-hidden />
                              {contatoSelecionado.data.phone_number}
                            </span>
                          ) : null}
                          {contatoSelecionado.data.email ? <span>{contatoSelecionado.data.email}</span> : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/app/contacts/${contactId}`}>
                          <ArrowSquareOut size={15} aria-hidden />
                          {t("Abrir contato")}
                        </Link>
                      </Button>
                      {contatoSelecionado.data.conversa?.id ? (
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/app/inbox?id=${contatoSelecionado.data.conversa.id}`}>
                            <ChatCircle size={15} aria-hidden />
                            {t("Abrir conversa no Inbox")}
                          </Link>
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={limparContato}>
                        {t("Trocar contato")}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative max-w-2xl">
                    <Input
                      className="h-11"
                      value={buscaContato}
                      onChange={(e) => setBuscaContato(e.target.value)}
                      placeholder={t("Busque pelo nome, telefone ou e-mail")}
                    />
                    {buscaContato.trim().length >= 2 ? (
                      <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-card shadow-lg">
                        {(contatos.data ?? []).map((contact) => (
                          <button
                            key={contact.id}
                            type="button"
                            onClick={() => escolherContato(contact)}
                            className="block w-full border-b p-3 text-left last:border-b-0 hover:bg-surface-elevated"
                          >
                            <span className="block font-medium">{rotuloContato(contact)}</span>
                            <span className="block text-xs text-text-muted">
                              {[contact.phone_number, contact.email].filter(Boolean).join(" · ")}
                            </span>
                          </button>
                        ))}
                        {!contatos.isLoading && (contatos.data?.length ?? 0) === 0 ? (
                          <p className="p-3 text-sm text-text-muted">{t("Nenhum contato encontrado.")}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setNovoContatoOpen(true)}>
                      {t("Criar novo contato")}
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <Link href="/app/clients">{t("Ver clientes")}</Link>
                    </Button>
                  </div>
                </div>
              )
            ) : (
              <div className="rounded-lg border border-border bg-surface-elevated/30 p-3 text-sm text-text-muted">
                {t("Os dados abaixo serão usados somente nesta cobrança, sem criar um contato automaticamente.")}
              </div>
            )}

            {origemCliente === "crm" &&
            contactId &&
            contatoSelecionado.data?.cpf_available &&
            !contatoSelecionado.data.cpf_decrypted ? (
              <p className="text-xs text-text-muted">
                {t("O contato possui CPF/CNPJ cadastrado, mas seu perfil não pode descriptografá-lo. Informe o documento abaixo para gerar a cobrança.")}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span>{t("Nome do cliente")}</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder={t("Ex.: Maria da Silva")}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t("CPF/CNPJ")}</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={cpfCnpj}
                onChange={(e) => setCpfCnpj(e.target.value)}
                inputMode="numeric"
                placeholder={t("CPF ou CNPJ")}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t("E-mail")}</span>
              <input
                type="email"
                className="min-h-11 w-full rounded-md border p-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("Opcional")}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t("Telefone")}</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
                inputMode="tel"
                placeholder={t("Opcional")}
              />
            </label>
            <div className="space-y-1.5 text-sm md:col-span-2 lg:col-span-3">
              <span>{t("Tipo de cobrança")}</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {([
                  ["single", t("Avulsa"), t("Uma cobrança com vencimento definido.")],
                  ["installment", t("Parcelada"), t("Divida o valor total em parcelas.")],
                  ["subscription", t("Recorrente / mensalidade"), t("Gere cobranças automaticamente por período.")],
                ] as const).map(([value, label, help]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setModo(value)}
                    className={
                      modo === value
                        ? "rounded-lg border border-accent bg-accent-soft p-3 text-left shadow-xs"
                        : "rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated"
                    }
                  >
                    <span className="block font-medium text-text">{label}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-text-muted">{help}</span>
                  </button>
                ))}
              </div>
            </div>
            <label className="space-y-1 text-sm">
              <span>{modo === "installment" ? t("Valor total") : t("Valor")}</span>
              <input
                className="min-h-11 w-full rounded-md border p-2"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                inputMode="decimal"
                placeholder={t("Ex.: 150,00")}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{modo === "subscription" ? t("Primeiro vencimento") : t("Vencimento")}</span>
              <input
                type="date"
                className="min-h-11 w-full rounded-md border p-2"
                value={vencimento}
                onChange={(e) => setVencimento(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>{t("Forma de cobrança")}</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={tipo}
                onChange={(e) => setTipo(e.target.value as Cobranca["billing_type"])}
              >
                <option value="PIX">{t("Pix")}</option>
                <option value="BOLETO">{t("Boleto")}</option>
                <option value="CREDIT_CARD">{t("Cartão")}</option>
                <option value="UNDEFINED">{t("Cliente escolhe")}</option>
              </select>
            </label>

            {modo === "installment" ? (
              <label className="space-y-1 text-sm">
                <span>{t("Número de parcelas")}</span>
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
                  <span>{t("Periodicidade")}</span>
                  <select
                    className="min-h-11 w-full rounded-md border p-2"
                    value={cycle}
                    onChange={(e) => setCycle(e.target.value as Cycle)}
                  >
                    {Object.entries(CICLO).map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span>{t("Quantidade máxima")}</span>
                  <input
                    className="min-h-11 w-full rounded-md border p-2"
                    value={maxPayments}
                    onChange={(e) => setMaxPayments(e.target.value)}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={240}
                    placeholder={t("Vazio = sem limite")}
                  />
                </label>
              </>
            ) : null}

            <label className="space-y-1 text-sm">
              <span>{t("Conta financeira")}</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={contaId}
                onChange={(e) => setContaId(e.target.value)}
              >
                <option value="">{t("Selecione")}</option>
                {(contas.data ?? []).map((conta) => (
                  <option key={conta.id} value={conta.id}>
                    {conta.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>{t("Plano de contas")}</span>
              <select
                className="min-h-11 w-full rounded-md border p-2"
                value={planoId}
                onChange={(e) => setPlanoId(e.target.value)}
              >
                <option value="">{t("Sem classificação")}</option>
                {planosEntrada.map((plano) => (
                  <option key={plano.id} value={plano.id}>
                    {plano.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details className="rounded-lg border border-border bg-surface-elevated/30 p-4">
            <summary className="cursor-pointer text-sm font-medium">
              {t("Juros, multa e desconto")}
            </summary>
            <p className="mt-2 text-xs text-text-muted">
              {t("Opcional. Se deixar em branco, o CRM não sobrescreve as regras globais configuradas no Asaas.")}
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 text-sm">
                <span>{t("Juros após vencimento (%)")}</span>
                <input
                  className="min-h-11 w-full rounded-md border p-2"
                  value={juros}
                  onChange={(e) => setJuros(e.target.value)}
                  inputMode="decimal"
                  placeholder={t("Ex.: 1")}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t("Multa por atraso (%)")}</span>
                <input
                  className="min-h-11 w-full rounded-md border p-2"
                  value={multa}
                  onChange={(e) => setMulta(e.target.value)}
                  inputMode="decimal"
                  placeholder={t("Ex.: 2")}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t("Desconto (%)")}</span>
                <input
                  className="min-h-11 w-full rounded-md border p-2"
                  value={desconto}
                  onChange={(e) => setDesconto(e.target.value)}
                  inputMode="decimal"
                  placeholder={t("Ex.: 5")}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t("Desconto até quantos dias antes")}</span>
                <input
                  className="min-h-11 w-full rounded-md border p-2"
                  value={descontoDias}
                  onChange={(e) => setDescontoDias(e.target.value)}
                  type="number"
                  min={0}
                  max={365}
                  inputMode="numeric"
                />
              </label>
            </div>
          </details>

          <label className="block space-y-1 text-sm">
            <span>{t("Descrição")}</span>
            <input
              className="min-h-11 w-full rounded-md border p-2"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder={t("Ex.: Honorários, consulta, mensalidade...")}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!podeEnviar || criar.isPending} onClick={() => criar.mutate()}>
              {criar.isPending ? t("Gerando…") : t("Gerar cobrança")}
            </Button>
            {valorCentavos > 0 ? (
              <span className="text-sm text-text-muted">
                {dinheiro(valorCentavos)}
                {modo === "installment" && numeroParcelas >= 2 ? ` · ${numeroParcelas}x` : ""}
              </span>
            ) : null}
          </div>
          </CardContent>
        </Card>
      ) : (
        <section className="rounded-xl border p-4 text-sm text-text-muted">
          {t("Seu perfil pode consultar cobranças, mas não criar novas.")}
        </section>
      )}

      {resultado ? (
        <section className="space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="font-semibold">{resultado.title}</h2>
            <p className="text-sm text-text-muted">
              {firstPayment
                ? <>{t("Primeira cobrança")}: {STATUS[firstPayment.status] ? t(STATUS[firstPayment.status]!) : firstPayment.status}</>
                : t("O Asaas criará as cobranças conforme o calendário configurado.")}
            </p>
          </div>

          {resultado.pix ? (
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="rounded-lg border bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${resultado.pix.encodedImage}`}
                  alt={t("QR Code Pix")}
                  className="h-auto w-full"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("Pix copia e cola")}</p>
                <textarea
                  readOnly
                  className="min-h-28 w-full rounded-md border p-2 text-xs"
                  value={resultado.pix.payload}
                />
                <Button variant="ghost" onClick={() => void copiarPixNovo()}>
                  {copiado ? t("Copiado") : t("Copiar código Pix")}
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
              {t("Abrir primeira cobrança")}
            </a>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t("Cobranças")}</h2>
            <p className="text-sm text-text-muted">
              {t("Status atualizado pelos webhooks do Asaas.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label={t("Filtrar por status")}
              className="min-h-11 rounded-md border p-2 text-sm"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value as Categoria)}
            >
              <option value="all">{t("Todos os status")}</option>
              <option value="pending">{t("Pendentes")}</option>
              <option value="received">{t("Pagos")}</option>
              <option value="overdue">{t("Vencidos")}</option>
              <option value="refunded">{t("Estornados")}</option>
              <option value="failed">{t("Falhas")}</option>
            </select>
            <select
              aria-label={t("Filtrar por forma de pagamento")}
              className="min-h-11 rounded-md border p-2 text-sm"
              value={filtroTipo}
              onChange={(e) =>
                setFiltroTipo(e.target.value as "all" | Cobranca["billing_type"])
              }
            >
              <option value="all">{t("Todas as formas")}</option>
              <option value="PIX">{t("Pix")}</option>
              <option value="BOLETO">{t("Boleto")}</option>
              <option value="CREDIT_CARD">{t("Cartão")}</option>
              <option value="UNDEFINED">{t("Cliente escolhe")}</option>
            </select>
            <Button
              variant="ghost"
              disabled={cobrancas.isFetching}
              onClick={() => void cobrancas.refetch()}
            >
              {cobrancas.isFetching ? t("Atualizando…") : t("Atualizar")}
            </Button>
          </div>
        </div>

        {mensagemAcao ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/20 bg-success-bg px-3 py-2 text-sm text-success-fg"
          >
            <span>{mensagemAcao}</span>
            {conversaEnviadaId ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`/app/inbox?id=${conversaEnviadaId}`}>
                  <ChatCircle size={15} aria-hidden />
                  {t("Abrir conversa no Inbox")}
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}

        {cobrancas.isLoading ? <p className="text-sm">{t("Carregando…")}</p> : null}

        {!cobrancas.isLoading && filtradas.length === 0 ? (
          <p className="text-sm text-text-muted">{t("Nenhuma cobrança neste filtro.")}</p>
        ) : null}

        <div className="space-y-3">
          {gruposCobrancas.map(({ chave, itens }) => {
            const primeira = itens[0]!;
            const parcelamento = Boolean(primeira.installment_id);
            const cliente = primeira.contact;

            if (!parcelamento) {
              const cobranca = primeira;
              return (
                <article
                  key={chave}
                  className="rounded-lg border border-border bg-surface p-4 shadow-xs transition-colors hover:border-border-strong"
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-lg font-semibold tabular-nums">{dinheiro(Number(cobranca.amount_cents))}</p>
                        <Badge variant={statusVariant(cobranca.status)}>
                          {STATUS[cobranca.status] ? t(STATUS[cobranca.status]!) : cobranca.status}
                        </Badge>
                        <Badge variant="neutral">{t(TIPO[cobranca.billing_type])}</Badge>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Cliente")}</p>
                          {cliente && cobranca.contact_id ? (
                            <div className="mt-1">
                              <Link href={`/app/contacts/${cobranca.contact_id}`} className="font-medium text-text underline-offset-4 hover:text-accent hover:underline">
                                {rotuloContato(cliente)}
                              </Link>
                              <p className="mt-0.5 text-sm text-text-muted">
                                {[cliente.phone_number, cliente.email].filter(Boolean).join(" · ")}
                              </p>
                            </div>
                          ) : (
                            <p className="mt-1 text-sm text-text-muted">{t("Cobrança sem contato vinculado")}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Detalhes")}</p>
                          <p className="mt-1 text-sm">{cobranca.description || t("Sem descrição")}</p>
                          <p className="mt-0.5 text-sm text-text-muted">{t("Vencimento")}: {dataBr(cobranca.due_date)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2 xl:max-w-sm xl:justify-end">
                      {cobranca.contact_id ? (
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/app/contacts/${cobranca.contact_id}`}><Users size={15} aria-hidden />{t("Cliente")}</Link>
                        </Button>
                      ) : null}
                      {cobranca.invoice_url ? (
                        <Button asChild variant="outline" size="sm">
                          <a href={cobranca.invoice_url} target="_blank" rel="noreferrer"><ArrowSquareOut size={15} aria-hidden />{t("Segunda via")}</a>
                        </Button>
                      ) : null}
                      {cobranca.billing_type === "PIX" && cobranca.asaas_payment_id ? (
                        <Button variant="outline" size="sm" disabled={copiarPixExistente.isPending} onClick={() => copiarPixExistente.mutate(cobranca.id)}>
                          {t("Copiar Pix")}
                        </Button>
                      ) : null}
                      {cobranca.contact_id && cobranca.asaas_payment_id && podeCobrar ? (
                        <Button size="sm" disabled={enviarWhatsApp.isPending} onClick={() => enviarWhatsApp.mutate(cobranca.id)}>
                          <WhatsappLogo size={15} aria-hidden />{t("Enviar WhatsApp")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            }

            const total = itens.reduce((soma, item) => soma + Number(item.amount_cents), 0);
            const pagas = itens.filter((item) => categoria(item.status) === "received").length;
            const vencidas = itens.filter((item) => categoria(item.status) === "overdue").length;
            const pendentes = itens.filter((item) => categoria(item.status) === "pending").length;
            const proxima =
              itens.find((item) => categoria(item.status) === "pending" || categoria(item.status) === "overdue") ??
              itens[itens.length - 1]!;
            const aberto = parcelamentosAbertos.includes(chave);

            return (
              <article key={chave} className="rounded-lg border border-border bg-surface p-4 shadow-xs">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-lg font-semibold">
                        {primeira.description || t("Parcelamento")}
                      </p>
                      <Badge variant="neutral">{t(TIPO[primeira.billing_type])}</Badge>
                      <Badge variant={vencidas > 0 ? "error" : pagas === itens.length ? "success" : "warning"}>
                        {pagas === itens.length ? t("Pago") : vencidas > 0 ? t("Com vencidas") : t("Em andamento")}
                      </Badge>
                    </div>
                    <p className="mt-2 text-base font-medium tabular-nums">
                      {dinheiro(total)} · {itens.length}x de {dinheiro(Number(primeira.amount_cents))}
                    </p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Cliente")}</p>
                        {cliente && primeira.contact_id ? (
                          <div className="mt-1">
                            <Link href={`/app/contacts/${primeira.contact_id}`} className="font-medium text-text underline-offset-4 hover:text-accent hover:underline">
                              {rotuloContato(cliente)}
                            </Link>
                            <p className="mt-0.5 text-sm text-text-muted">{[cliente.phone_number, cliente.email].filter(Boolean).join(" · ")}</p>
                          </div>
                        ) : (
                          <p className="mt-1 text-sm text-text-muted">{t("Cobrança sem contato vinculado")}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Resumo")}</p>
                        <p className="mt-1 text-sm">{pagas} {t("pagas")} · {pendentes} {t("pendentes")} · {vencidas} {t("vencidas")}</p>
                        <p className="mt-0.5 text-sm text-text-muted">{t("Próximo vencimento")}: {dataBr(proxima.due_date)}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 xl:max-w-md xl:justify-end">
                    <Button variant="outline" size="sm" onClick={() => alternarParcelamento(chave)}>
                      {aberto ? t("Ocultar parcelas") : t("Ver parcelas")}
                    </Button>
                    {primeira.contact_id ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/app/contacts/${primeira.contact_id}`}><Users size={15} aria-hidden />{t("Cliente")}</Link>
                      </Button>
                    ) : null}
                    {proxima.contact_id && proxima.asaas_payment_id && podeCobrar ? (
                      <Button size="sm" disabled={enviarWhatsApp.isPending} onClick={() => enviarWhatsApp.mutate(proxima.id)}>
                        <WhatsappLogo size={15} aria-hidden />{t("Enviar próxima")}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {aberto ? (
                  <div className="mt-4 space-y-2 border-t border-border pt-4">
                    {itens.map((parcela) => (
                      <div key={parcela.id} className="flex flex-col gap-2 rounded-md bg-surface-elevated/50 p-3 md:flex-row md:items-center md:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{t("Parcela")} {parcela.installment_number ?? "—"}/{itens.length}</span>
                          <span className="text-sm tabular-nums">{dinheiro(Number(parcela.amount_cents))}</span>
                          <Badge variant={statusVariant(parcela.status)}>{STATUS[parcela.status] ? t(STATUS[parcela.status]!) : parcela.status}</Badge>
                          <span className="text-xs text-text-muted">{dataBr(parcela.due_date)}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {parcela.invoice_url ? (
                            <Button asChild variant="outline" size="sm">
                              <a href={parcela.invoice_url} target="_blank" rel="noreferrer">{t("Segunda via")}</a>
                            </Button>
                          ) : null}
                          {parcela.billing_type === "PIX" && parcela.asaas_payment_id ? (
                            <Button variant="outline" size="sm" disabled={copiarPixExistente.isPending} onClick={() => copiarPixExistente.mutate(parcela.id)}>
                              {t("Copiar Pix")}
                            </Button>
                          ) : null}
                          {parcela.contact_id && parcela.asaas_payment_id && podeCobrar ? (
                            <Button size="sm" disabled={enviarWhatsApp.isPending} onClick={() => enviarWhatsApp.mutate(parcela.id)}>
                              <WhatsappLogo size={15} aria-hidden />{t("WhatsApp")}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <NewContactDialog      <NewContactDialog
        open={novoContatoOpen}
        onOpenChange={setNovoContatoOpen}
        nomeInicial={buscaContato.trim() || undefined}
        onCriado={escolherContato}
      />

      <section className="space-y-3 rounded-xl border p-4">
        <div>
          <h2 className="font-semibold">{t("Recorrências / mensalidades")}</h2>
          <p className="text-sm text-text-muted">
            {t("O Asaas gera novas cobranças automaticamente conforme a periodicidade.")}
          </p>
        </div>
        {assinaturas.isLoading ? <p className="text-sm">{t("Carregando…")}</p> : null}
        {!assinaturas.isLoading && (assinaturas.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-text-muted">{t("Nenhuma recorrência criada.")}</p>
        ) : null}
        <div className="space-y-2">
          {(assinaturas.data ?? []).map((assinatura) => (
            <div
              key={assinatura.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">
                    {assinatura.description || t("Mensalidade")} · {dinheiro(Number(assinatura.amount_cents))}
                  </p>
                  <Badge variant={assinatura.status === "ACTIVE" ? "success" : "neutral"}>
                    {assinatura.status}
                  </Badge>
                </div>
                {assinatura.contact && assinatura.contact_id ? (
                  <p className="mt-1 text-sm">
                    <Link
                      href={`/app/contacts/${assinatura.contact_id}`}
                      className="font-medium underline-offset-4 hover:text-accent hover:underline"
                    >
                      {rotuloContato(assinatura.contact)}
                    </Link>
                    {assinatura.contact.phone_number ? (
                      <span className="text-text-muted"> · {assinatura.contact.phone_number}</span>
                    ) : null}
                  </p>
                ) : null}
                <p className="mt-1 text-sm text-text-muted">
                  {t(CICLO[assinatura.cycle])} · {t("próximo vencimento")} {dataBr(assinatura.next_due_date)}
                  {assinatura.max_payments ? <> · {t("até")} {assinatura.max_payments} {t("cobranças")}</> : null}
                </p>
              </div>
              {assinatura.contact_id ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/app/contacts/${assinatura.contact_id}`}>
                    <Users size={15} aria-hidden />
                    {t("Ver cliente")}
                  </Link>
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
