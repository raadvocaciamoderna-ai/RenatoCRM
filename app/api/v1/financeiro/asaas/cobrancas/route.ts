import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import {
  AsaasApiError,
  createAsaasPayment,
  findAsaasPaymentByExternalReference,
  getAsaasPixQrCode,
  type AsaasPayment,
} from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { criarCobrancaAsaasSchema } from "@/lib/asaas/schemas";
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
    .from("asaas_payments")
    .select(
      "id, contact_id, asaas_payment_id, installment_id, subscription_id, installment_number, billing_type, amount_cents, due_date, description, status, invoice_url, needs_reconciliation, created_at",
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

  const parsed = criarCobrancaAsaasSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      parsed.error.issues[0]?.message ?? "Corpo inválido.",
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  const { data: account, error: accountError } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.account_id)
    .eq("is_active", true)
    .maybeSingle();

  if (accountError) {
    return fail("internal_error", accountError.message, 500, { requestId });
  }
  if (!account) {
    return fail("validation_failed", "Conta financeira inválida ou inativa.", 422, {
      requestId,
    });
  }

  if (parsed.data.account_plan_id) {
    const { data: plan, error: planError } = await supabase
      .from("account_plans")
      .select("id, direction")
      .eq("organization_id", authz.org.orgId)
      .eq("id", parsed.data.account_plan_id)
      .eq("is_active", true)
      .maybeSingle();

    if (planError) {
      return fail("internal_error", planError.message, 500, { requestId });
    }
    if (!plan || plan.direction !== "in") {
      return fail(
        "validation_failed",
        "O plano de contas da cobrança precisa ser uma entrada ativa.",
        422,
        { requestId },
      );
    }
  }

  const localPaymentId = randomUUID();
  const externalReference = `crm-payment:${localPaymentId}`;

  const { error: reserveError } = await supabase.from("asaas_payments").insert({
    id: localPaymentId,
    organization_id: authz.org.orgId,
    asaas_customer_id: parsed.data.customer_id,
    contact_id: parsed.data.contact_id ?? null,
    external_reference: externalReference,
    billing_type: parsed.data.billing_type,
    amount_cents: parsed.data.value_cents,
    due_date: parsed.data.due_date,
    description: parsed.data.description ?? null,
    status: "CREATING",
    account_id: parsed.data.account_id,
    account_plan_id: parsed.data.account_plan_id ?? null,
    created_by_user_id: authz.user.id,
  });

  if (reserveError) {
    return fail("internal_error", reserveError.message, 500, { requestId });
  }

  let payment: AsaasPayment | null = null;

  try {
    payment = await createAsaasPayment({
      customer: parsed.data.customer_id,
      billingType: parsed.data.billing_type,
      value: parsed.data.value_cents / 100,
      dueDate: parsed.data.due_date,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      externalReference,
    });
  } catch (error) {
    // Timeout/5xx deixa o resultado remoto incerto. Antes de permitir uma nova
    // tentativa, consulta pela externalReference que reservamos localmente para
    // não criar duas cobranças no Asaas.
    if (error instanceof AsaasApiError && error.status >= 500) {
      try {
        payment = await findAsaasPaymentByExternalReference(externalReference);
      } catch {
        payment = null;
      }
    }

    if (!payment) {
      const mapped = describeAsaasError(error);
      await supabase
        .from("asaas_payments")
        .update({
          status: "CREATE_FAILED",
          last_error: mapped.message.slice(0, 500),
        })
        .eq("id", localPaymentId)
        .eq("organization_id", authz.org.orgId);

      return fail(mapped.code, mapped.message, mapped.status, { requestId });
    }
  }

  const { error: syncError } = await supabase
    .from("asaas_payments")
    .update({
      asaas_payment_id: payment.id,
      status: payment.status,
      invoice_url: payment.invoiceUrl ?? null,
      last_error: null,
    })
    .eq("id", localPaymentId)
    .eq("organization_id", authz.org.orgId);

  if (syncError) {
    return fail(
      "asaas_local_sync_failed",
      "A cobrança foi criada no Asaas, mas o vínculo local não foi concluído. Não repita a cobrança antes de reconciliar.",
      500,
      { requestId },
    );
  }

  let pix: Awaited<ReturnType<typeof getAsaasPixQrCode>> | null = null;
  let pixError: string | null = null;

  if (parsed.data.billing_type === "PIX") {
    try {
      pix = await getAsaasPixQrCode(payment.id);
    } catch (error) {
      pixError = describeAsaasError(error).message;
    }
  }

  return ok(
    {
      local_payment_id: localPaymentId,
      payment,
      pix,
      pix_error: pixError,
    },
    { status: 201, requestId },
  );
}
