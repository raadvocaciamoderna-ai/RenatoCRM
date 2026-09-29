import "server-only";

import { env } from "@/lib/env";

const SANDBOX_BASE_URL = "https://api-sandbox.asaas.com/v3";
const PRODUCTION_BASE_URL = "https://api.asaas.com/v3";
const OFFICIAL_BASE_URLS = new Set([SANDBOX_BASE_URL, PRODUCTION_BASE_URL]);

export type AsaasEnvironment = "sandbox" | "production";

export type AsaasCustomer = {
  object?: "customer";
  id: string;
  name?: string;
  cpfCnpj?: string;
  email?: string | null;
  mobilePhone?: string | null;
  externalReference?: string | null;
  deleted?: boolean;
  [key: string]: unknown;
};

export type AsaasPayment = {
  object?: "payment";
  id: string;
  customer: string;
  billingType: string;
  value: number;
  netValue?: number;
  status: string;
  dueDate: string;
  description?: string | null;
  externalReference?: string | null;
  invoiceUrl?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  installment?: string | null;
  subscription?: string | null;
  installmentNumber?: number | null;
  [key: string]: unknown;
};

export type AsaasInstallment = {
  object?: "installment";
  id: string;
  customer?: string;
  value?: number;
  netValue?: number;
  installmentCount?: number;
  billingType?: string;
  status?: string;
  [key: string]: unknown;
};

export type AsaasSubscription = {
  object?: "subscription";
  id: string;
  customer?: string;
  billingType?: string;
  value?: number;
  nextDueDate?: string;
  cycle?: string;
  description?: string | null;
  status?: string;
  externalReference?: string | null;
  [key: string]: unknown;
};

export type AsaasPixQrCode = {
  encodedImage: string;
  payload: string;
  expirationDate: string;
  [key: string]: unknown;
};

export type AsaasWebhook = {
  id: string;
  name?: string;
  url?: string;
  enabled?: boolean;
  interrupted?: boolean;
  sendType?: string;
  events?: string[];
  [key: string]: unknown;
};

type AsaasList<T> = {
  object?: "list";
  hasMore?: boolean;
  totalCount?: number;
  limit?: number;
  offset?: number;
  data: T[];
};

export class AsaasConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsaasConfigError";
  }
}

export class AsaasApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "AsaasApiError";
    this.status = status;
    this.payload = payload;
  }
}

function normalizeBaseUrl(raw: string): string {
  const normalized = (raw.trim() || SANDBOX_BASE_URL).replace(/\/+$/, "");
  if (!OFFICIAL_BASE_URLS.has(normalized)) {
    throw new AsaasConfigError(
      "ASAAS_API_BASE_URL inválida. Use somente a URL oficial do Sandbox ou da Produção.",
    );
  }
  return normalized;
}

export function asaasConfig() {
  const apiKey = env.ASAAS_API_KEY.trim();
  const baseUrl = normalizeBaseUrl(env.ASAAS_API_BASE_URL);
  const environment: AsaasEnvironment =
    baseUrl === SANDBOX_BASE_URL ? "sandbox" : "production";

  return {
    apiKey,
    baseUrl,
    environment,
    configured: apiKey.length > 0,
    webhookTokenConfigured: env.ASAAS_WEBHOOK_TOKEN.trim().length >= 32,
  };
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const obj = payload as Record<string, unknown>;
  const errors = obj.errors;
  if (Array.isArray(errors)) {
    const first = errors[0];
    if (first && typeof first === "object") {
      const description = (first as Record<string, unknown>).description;
      if (typeof description === "string" && description.trim()) return description;
    }
  }
  const message = obj.message;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

export async function asaasRequest<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const config = asaasConfig();
  if (!config.configured) {
    throw new AsaasConfigError("ASAAS_API_KEY não está configurada nesta instalação.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "crm-asaas-integration/1.0",
        access_token: config.apiKey,
        ...init.headers,
      },
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      throw new AsaasApiError(
        response.status,
        apiErrorMessage(payload, `Asaas respondeu HTTP ${response.status}.`),
        payload,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof AsaasApiError || error instanceof AsaasConfigError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AsaasApiError(504, "Tempo limite ao comunicar com o Asaas.", null);
    }
    throw new AsaasApiError(
      502,
      error instanceof Error ? error.message : "Falha de comunicação com o Asaas.",
      null,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function testAsaasConnection(): Promise<void> {
  await asaasRequest<AsaasList<AsaasCustomer>>("/customers?limit=1&offset=0");
}

export async function getAsaasCustomer(id: string): Promise<AsaasCustomer> {
  return asaasRequest<AsaasCustomer>(`/customers/${encodeURIComponent(id)}`);
}

export async function getAsaasPayment(id: string): Promise<AsaasPayment> {
  return asaasRequest<AsaasPayment>(`/payments/${encodeURIComponent(id)}`);
}

export async function findAsaasCustomerByCpfCnpj(cpfCnpj: string): Promise<AsaasCustomer | null> {
  const params = new URLSearchParams({ cpfCnpj, limit: "1", offset: "0" });
  const result = await asaasRequest<AsaasList<AsaasCustomer>>(`/customers?${params.toString()}`);
  return result.data?.[0] ?? null;
}

export async function createAsaasCustomer(input: {
  name: string;
  cpfCnpj: string;
  email?: string;
  mobilePhone?: string;
  externalReference?: string;
}): Promise<AsaasCustomer> {
  return asaasRequest<AsaasCustomer>("/customers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createAsaasPayment(input: {
  customer: string;
  billingType: "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";
  value: number;
  dueDate: string;
  description?: string;
  externalReference: string;
}): Promise<AsaasPayment> {
  return asaasRequest<AsaasPayment>("/payments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createAsaasInstallment(input: {
  customer: string;
  billingType: "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";
  installmentCount: number;
  totalValue: number;
  dueDate: string;
  description?: string;
  externalReference: string;
}): Promise<AsaasPayment> {
  // O fluxo recomendado pelo Asaas para informar o valor TOTAL do parcelamento
  // é POST /payments com installmentCount + totalValue. A resposta é a primeira
  // cobrança e traz o identificador do parcelamento em `installment`.
  return asaasRequest<AsaasPayment>("/payments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAsaasInstallmentPayments(
  installmentId: string,
): Promise<AsaasPayment[]> {
  const result = await asaasRequest<AsaasList<AsaasPayment>>(
    `/installments/${encodeURIComponent(installmentId)}/payments?limit=100&offset=0`,
  );
  return result.data ?? [];
}

export async function createAsaasSubscription(input: {
  customer: string;
  billingType: "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";
  value: number;
  nextDueDate: string;
  cycle: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "BIMONTHLY" | "QUARTERLY" | "SEMIANNUALLY" | "YEARLY";
  description?: string;
  maxPayments?: number;
  externalReference: string;
}): Promise<AsaasSubscription> {
  return asaasRequest<AsaasSubscription>("/subscriptions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAsaasSubscriptionPayments(
  subscriptionId: string,
): Promise<AsaasPayment[]> {
  const result = await asaasRequest<AsaasList<AsaasPayment>>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
  );
  return result.data ?? [];
}

export async function findAsaasSubscriptionByExternalReference(
  externalReference: string,
): Promise<AsaasSubscription | null> {
  const params = new URLSearchParams({
    externalReference,
    limit: "1",
    offset: "0",
  });
  const result = await asaasRequest<AsaasList<AsaasSubscription>>(
    `/subscriptions?${params.toString()}`,
  );
  return result.data?.[0] ?? null;
}

export async function findAsaasPaymentByExternalReference(
  externalReference: string,
): Promise<AsaasPayment | null> {
  const params = new URLSearchParams({
    externalReference,
    limit: "1",
    offset: "0",
  });
  const result = await asaasRequest<AsaasList<AsaasPayment>>(
    `/payments?${params.toString()}`,
  );
  return result.data?.[0] ?? null;
}

export async function getAsaasPixQrCode(paymentId: string): Promise<AsaasPixQrCode> {
  return asaasRequest<AsaasPixQrCode>(
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
  );
}

export async function listAsaasWebhooks(): Promise<AsaasWebhook[]> {
  const result = await asaasRequest<AsaasList<AsaasWebhook>>("/webhooks?limit=100&offset=0");
  return result.data ?? [];
}

export async function upsertAsaasWebhook(input: {
  email: string;
  url: string;
}): Promise<{ webhook: AsaasWebhook; created: boolean }> {
  const authToken = env.ASAAS_WEBHOOK_TOKEN.trim();
  if (authToken.length < 32) {
    throw new AsaasConfigError(
      "ASAAS_WEBHOOK_TOKEN precisa ter pelo menos 32 caracteres antes de configurar o webhook.",
    );
  }

  const body = {
    name: "CRM Financeiro",
    url: input.url,
    email: input.email,
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken,
    sendType: "SEQUENTIALLY",
    events: [
      "PAYMENT_CREATED",
      "PAYMENT_UPDATED",
      "PAYMENT_CONFIRMED",
      "PAYMENT_RECEIVED",
      "PAYMENT_OVERDUE",
      "PAYMENT_DELETED",
      "PAYMENT_RESTORED",
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_REFUND_IN_PROGRESS",
      "PAYMENT_RECEIVED_IN_CASH_UNDONE",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_CHARGEBACK_DISPUTE",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ],
  };

  const existing = (await listAsaasWebhooks()).find((item) => item.url === input.url);
  if (existing?.id) {
    const webhook = await asaasRequest<AsaasWebhook>(
      `/webhooks/${encodeURIComponent(existing.id)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
    return { webhook, created: false };
  }

  const webhook = await asaasRequest<AsaasWebhook>("/webhooks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { webhook, created: true };
}
