import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import {
  AsaasApiError,
  createAsaasInstallment,
  findAsaasPaymentByExternalReference,
  getAsaasPixQrCode,
  listAsaasInstallmentPayments,
} from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { criarParcelamentoAsaasSchema } from "@/lib/asaas/schemas";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function validarCatalogo(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  accountId: string,
  accountPlanId?: string | null,
): Promise<string | null> {
  const { data: account, error: accountError } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", accountId)
    .eq("is_active", true)
    .maybeSingle();
  if (accountError) return accountError.message;
  if (!account) return "Conta financeira inválida ou inativa.";

  if (accountPlanId) {
    const { data: plan, error: planError } = await supabase
      .from("account_plans")
      .select("id, direction")
      .eq("organization_id", organizationId)
      .eq("id", accountPlanId)
      .eq("is_active", true)
      .maybeSingle();
    if (planError) return planError.message;
    if (!plan || plan.direction !== "in") {
      return "O plano de contas do parcelamento precisa ser uma entrada ativa.";
    }
  }

  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const parsed = criarParcelamentoAsaasSchema.safeParse(await req.json().catch(() => ({})));
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
  const catalogo = await validarCatalogo(
    supabase,
    authz.org.orgId,
    parsed.data.account_id,
    parsed.data.account_plan_id,
  );
  if (catalogo) {
    return fail("validation_failed", catalogo, 422, { requestId });
  }

  const localInstallmentId = randomUUID();
  const paymentExternalReference = `crm-installment:${localInstallmentId}`;

  let remoteId: string | null = null;
  let remoteInstallment: Record<string, unknown> | null = null;

  try {
    const created = await createAsaasInstallment({
      customer: parsed.data.customer_id,
      billingType: parsed.data.billing_type,
      installmentCount: parsed.data.installment_count,
      totalValue: parsed.data.total_value_cents / 100,
      dueDate: parsed.data.due_date,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      externalReference: paymentExternalReference,
    });
    remoteId =
      typeof created.installment === "string" && created.installment
        ? created.installment
        : null;
    remoteInstallment = remoteId ? { id: remoteId } : null;
  } catch (error) {
    if (error instanceof AsaasApiError && error.status >= 500) {
      try {
        const payment = await findAsaasPaymentByExternalReference(paymentExternalReference);
        if (typeof payment?.installment === "string" && payment.installment) {
          remoteId = payment.installment;
        }
      } catch {
        remoteId = null;
      }
    }

    if (!remoteId) {
      const mapped = describeAsaasError(error);
      return fail(mapped.code, mapped.message, mapped.status, { requestId });
    }
  }

  if (!remoteId) {
    return fail("asaas_local_sync_failed", "O Asaas não devolveu o identificador do parcelamento.", 500, {
      requestId,
    });
  }

  let payments: Awaited<ReturnType<typeof listAsaasInstallmentPayments>>;
  try {
    payments = await listAsaasInstallmentPayments(remoteId);
  } catch (error) {
    const mapped = describeAsaasError(error);
    return fail(mapped.code, mapped.message, mapped.status, { requestId });
  }

  const { error: installmentError } = await supabase.from("asaas_installments").insert({
    id: localInstallmentId,
    organization_id: authz.org.orgId,
    contact_id: parsed.data.contact_id ?? null,
    asaas_installment_id: remoteId,
    asaas_customer_id: parsed.data.customer_id,
    billing_type: parsed.data.billing_type,
    total_amount_cents: parsed.data.total_value_cents,
    installment_count: parsed.data.installment_count,
    first_due_date: parsed.data.due_date,
    description: parsed.data.description ?? null,
    account_id: parsed.data.account_id,
    account_plan_id: parsed.data.account_plan_id ?? null,
    created_by_user_id: authz.user.id,
  });
  if (installmentError) {
    return fail("asaas_local_sync_failed", installmentError.message, 500, { requestId });
  }

  const rows = payments.map((payment, index) => ({
    organization_id: authz.org.orgId,
    contact_id: parsed.data.contact_id ?? null,
    asaas_payment_id: payment.id,
    asaas_customer_id: parsed.data.customer_id,
    external_reference: `crm-installment-payment:${localInstallmentId}:${index + 1}`,
    installment_id: remoteId,
    installment_number: payment.installmentNumber ?? index + 1,
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

  if (rows.length > 0) {
    const { error: paymentError } = await supabase.from("asaas_payments").insert(rows);
    if (paymentError) {
      return fail(
        "asaas_local_sync_failed",
        "O parcelamento foi criado no Asaas, mas as parcelas não foram gravadas integralmente no CRM. Não crie outro parcelamento antes de reconciliar.",
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
      local_installment_id: localInstallmentId,
      installment: remoteInstallment ?? { id: remoteId },
      payments,
      pix,
    },
    { status: 201, requestId },
  );
}
