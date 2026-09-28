import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import {
  createAsaasSubscription,
  getAsaasPixQrCode,
  listAsaasSubscriptionPayments,
} from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { criarAssinaturaAsaasSchema } from "@/lib/asaas/schemas";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const rawLimit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 50;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("asaas_subscriptions")
    .select(
      "id, contact_id, asaas_subscription_id, billing_type, amount_cents, cycle, next_due_date, description, max_payments, status, created_at",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const parsed = criarAssinaturaAsaasSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? "Corpo inválido.", 422, {
      requestId,
    });
  }

  const supabase = await createClient();

  if (parsed.data.contact_id) {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", parsed.data.contact_id)
      .maybeSingle();
    if (contactError) return fail("internal_error", contactError.message, 500, { requestId });
    if (!contact) {
      return fail("validation_failed", "Contato não pertence a esta organização.", 422, {
        requestId,
      });
    }
  }

  const { data: account, error: accountError } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.account_id)
    .eq("is_active", true)
    .maybeSingle();
  if (accountError) return fail("internal_error", accountError.message, 500, { requestId });
  if (!account) {
    return fail("validation_failed", "Conta financeira inválida ou inativa.", 422, { requestId });
  }

  if (parsed.data.account_plan_id) {
    const { data: plan, error: planError } = await supabase
      .from("account_plans")
      .select("id, direction")
      .eq("organization_id", authz.org.orgId)
      .eq("id", parsed.data.account_plan_id)
      .eq("is_active", true)
      .maybeSingle();
    if (planError) return fail("internal_error", planError.message, 500, { requestId });
    if (!plan || plan.direction !== "in") {
      return fail(
        "validation_failed",
        "O plano de contas da assinatura precisa ser uma entrada ativa.",
        422,
        { requestId },
      );
    }
  }

  const localSubscriptionId = randomUUID();
  const externalReference = `crm-subscription:${localSubscriptionId}`;

  let subscription;
  try {
    subscription = await createAsaasSubscription({
      customer: parsed.data.customer_id,
      billingType: parsed.data.billing_type,
      value: parsed.data.value_cents / 100,
      nextDueDate: parsed.data.next_due_date,
      cycle: parsed.data.cycle,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.max_payments ? { maxPayments: parsed.data.max_payments } : {}),
      externalReference,
    });
  } catch (error) {
    const mapped = describeAsaasError(error);
    return fail(mapped.code, mapped.message, mapped.status, { requestId });
  }

  const { error: subscriptionError } = await supabase.from("asaas_subscriptions").insert({
    id: localSubscriptionId,
    organization_id: authz.org.orgId,
    contact_id: parsed.data.contact_id ?? null,
    asaas_subscription_id: subscription.id,
    asaas_customer_id: parsed.data.customer_id,
    billing_type: parsed.data.billing_type,
    amount_cents: parsed.data.value_cents,
    cycle: parsed.data.cycle,
    next_due_date: parsed.data.next_due_date,
    description: parsed.data.description ?? null,
    max_payments: parsed.data.max_payments ?? null,
    account_id: parsed.data.account_id,
    account_plan_id: parsed.data.account_plan_id ?? null,
    status: subscription.status ?? "ACTIVE",
    created_by_user_id: authz.user.id,
  });

  if (subscriptionError) {
    return fail(
      "asaas_local_sync_failed",
      "A assinatura foi criada no Asaas, mas o vínculo local não foi concluído. Não crie outra antes de reconciliar.",
      500,
      { requestId },
    );
  }

  let payments: Awaited<ReturnType<typeof listAsaasSubscriptionPayments>> = [];
  try {
    payments = await listAsaasSubscriptionPayments(subscription.id);
  } catch {
    payments = [];
  }

  if (payments.length > 0) {
    const rows = payments.map((payment, index) => ({
      organization_id: authz.org.orgId,
      contact_id: parsed.data.contact_id ?? null,
      asaas_payment_id: payment.id,
      asaas_customer_id: parsed.data.customer_id,
      external_reference: `crm-subscription-payment:${localSubscriptionId}:${index + 1}`,
      subscription_id: subscription.id,
      billing_type: parsed.data.billing_type,
      amount_cents: Math.round(payment.value * 100),
      due_date: payment.dueDate,
      description: payment.description ?? parsed.data.description ?? null,
      status: payment.status,
      invoice_url: payment.invoiceUrl ?? null,
      account_id: parsed.data.account_id,
      account_plan_id: parsed.data.account_plan_id ?? null,
      created_by_user_id: authz.user.id,
    }));
    const { error: paymentError } = await supabase.from("asaas_payments").insert(rows);
    if (paymentError && paymentError.code !== "23505") {
      return fail(
        "asaas_local_sync_failed",
        "A assinatura foi criada, mas as primeiras cobranças não foram sincronizadas no CRM.",
        500,
        { requestId },
      );
    }
  }

  let pix = null;
  if (parsed.data.billing_type === "PIX" && payments[0]?.id) {
    try {
      pix = await getAsaasPixQrCode(payments[0].id);
    } catch {
      pix = null;
    }
  }

  return ok(
    {
      local_subscription_id: localSubscriptionId,
      subscription,
      payments,
      pix,
    },
    { status: 201, requestId },
  );
}
