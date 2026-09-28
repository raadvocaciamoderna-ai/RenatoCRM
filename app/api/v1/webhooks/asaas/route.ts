import { randomUUID, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { webhookAsaasSchema } from "@/lib/asaas/schemas";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function secureEquals(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function finishEvent(
  eventId: string,
  values: { organization_id?: string | null; error?: string | null },
) {
  const admin = createAdminClient();
  await admin
    .from("asaas_webhook_events")
    .update({
      processed_at: new Date().toISOString(),
      organization_id: values.organization_id ?? null,
      error: values.error ?? null,
    })
    .eq("event_id", eventId);
}

async function failEvent(eventId: string, message: string, organizationId?: string | null) {
  const admin = createAdminClient();
  await admin
    .from("asaas_webhook_events")
    .update({
      organization_id: organizationId ?? null,
      error: message.slice(0, 500),
    })
    .eq("event_id", eventId);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const expectedToken = env.ASAAS_WEBHOOK_TOKEN.trim();

  if (expectedToken.length < 32) {
    return fail(
      "asaas_webhook_not_configured",
      "Webhook Asaas não configurado nesta instalação.",
      503,
      { requestId },
    );
  }

  const receivedToken = req.headers.get("asaas-access-token") ?? "";
  if (!receivedToken || !secureEquals(receivedToken, expectedToken)) {
    return fail("unauthorized", "Token de webhook inválido.", 401, { requestId });
  }

  const parsed = webhookAsaasSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      parsed.error.issues[0]?.message ?? "Payload Asaas inválido.",
      422,
      { requestId },
    );
  }

  const event = parsed.data;
  const admin = createAdminClient();

  const { data: existing, error: existingError } = await admin
    .from("asaas_webhook_events")
    .select("event_id, processed_at")
    .eq("event_id", event.id)
    .maybeSingle();

  if (existingError) {
    return fail("internal_error", existingError.message, 500, { requestId });
  }

  if (existing?.processed_at) {
    return ok({ received: true, duplicate: true }, { requestId });
  }

  if (!existing) {
    const { error: insertEventError } = await admin.from("asaas_webhook_events").insert({
      event_id: event.id,
      event_type: event.event,
      asaas_payment_id: event.payment.id,
    });

    if (insertEventError && insertEventError.code !== "23505") {
      return fail("internal_error", insertEventError.message, 500, { requestId });
    }
  }

  let { data: localPayment, error: paymentLookupError } = await admin
    .from("asaas_payments")
    .select(
      "id, organization_id, asaas_payment_id, external_reference, status, financial_entry_id, reversal_entry_id",
    )
    .eq("asaas_payment_id", event.payment.id)
    .maybeSingle();

  if (paymentLookupError) {
    await failEvent(event.id, paymentLookupError.message);
    return fail("internal_error", paymentLookupError.message, 500, { requestId });
  }

  if (!localPayment && event.payment.externalReference) {
    const fallback = await admin
      .from("asaas_payments")
      .select(
        "id, organization_id, asaas_payment_id, external_reference, status, financial_entry_id, reversal_entry_id",
      )
      .eq("external_reference", event.payment.externalReference)
      .maybeSingle();

    paymentLookupError = fallback.error;
    localPayment = fallback.data;

    if (paymentLookupError) {
      await failEvent(event.id, paymentLookupError.message);
      return fail("internal_error", paymentLookupError.message, 500, { requestId });
    }
  }

  // Cobranças geradas por ASSINATURA ou PARCELAMENTO nascem no Asaas sem uma
  // linha local prévia. O vínculo com o recurso-pai é a autorização para
  // adotá-las: depois disto elas seguem exatamente o mesmo fluxo financeiro
  // idempotente de uma cobrança avulsa.
  if (!localPayment && event.payment.subscription) {
    const { data: subscription, error: subscriptionError } = await admin
      .from("asaas_subscriptions")
      .select(
        "organization_id, contact_id, asaas_customer_id, billing_type, amount_cents, next_due_date, description, account_id, account_plan_id, created_by_user_id",
      )
      .eq("asaas_subscription_id", event.payment.subscription)
      .maybeSingle();

    if (subscriptionError) {
      await failEvent(event.id, subscriptionError.message);
      return fail("internal_error", subscriptionError.message, 500, { requestId });
    }

    if (subscription) {
      const row = {
        organization_id: subscription.organization_id,
        contact_id: subscription.contact_id,
        asaas_payment_id: event.payment.id,
        asaas_customer_id: event.payment.customer ?? subscription.asaas_customer_id,
        external_reference: `asaas-webhook:${event.payment.id}`,
        subscription_id: event.payment.subscription,
        billing_type: event.payment.billingType ?? subscription.billing_type,
        amount_cents:
          typeof event.payment.value === "number"
            ? Math.round(event.payment.value * 100)
            : subscription.amount_cents,
        due_date: event.payment.dueDate ?? subscription.next_due_date,
        description: event.payment.description ?? subscription.description,
        status: event.payment.status ?? "PENDING",
        invoice_url: event.payment.invoiceUrl ?? null,
        account_id: subscription.account_id,
        account_plan_id: subscription.account_plan_id,
        created_by_user_id: subscription.created_by_user_id,
      };
      const inserted = await admin
        .from("asaas_payments")
        .insert(row)
        .select(
          "id, organization_id, asaas_payment_id, external_reference, status, financial_entry_id, reversal_entry_id",
        )
        .maybeSingle();

      if (inserted.error && inserted.error.code !== "23505") {
        await failEvent(event.id, inserted.error.message, subscription.organization_id);
        return fail("internal_error", inserted.error.message, 500, { requestId });
      }
      if (inserted.data) {
        localPayment = inserted.data;
      } else {
        const existingGenerated = await admin
          .from("asaas_payments")
          .select(
            "id, organization_id, asaas_payment_id, external_reference, status, financial_entry_id, reversal_entry_id",
          )
          .eq("asaas_payment_id", event.payment.id)
          .maybeSingle();
        if (existingGenerated.error) {
          await failEvent(event.id, existingGenerated.error.message, subscription.organization_id);
          return fail("internal_error", existingGenerated.error.message, 500, { requestId });
        }
        localPayment = existingGenerated.data;
      }
    }
  }

  if (!localPayment && event.payment.installment) {
    const { data: installment, error: installmentError } = await admin
      .from("asaas_installments")
      .select(
        "organization_id, contact_id, asaas_customer_id, billing_type, total_amount_cents, installment_count, first_due_date, description, account_id, account_plan_id, created_by_user_id",
      )
      .eq("asaas_installment_id", event.payment.installment)
      .maybeSingle();

    if (installmentError) {
      await failEvent(event.id, installmentError.message);
      return fail("internal_error", installmentError.message, 500, { requestId });
    }

    if (installment) {
      const fallbackAmount = Math.max(
        1,
        Math.round(installment.total_amount_cents / installment.installment_count),
      );
      const row = {
        organization_id: installment.organization_id,
        contact_id: installment.contact_id,
        asaas_payment_id: event.payment.id,
        asaas_customer_id: event.payment.customer ?? installment.asaas_customer_id,
        external_reference: `asaas-webhook:${event.payment.id}`,
        installment_id: event.payment.installment,
        installment_number: event.payment.installmentNumber ?? null,
        billing_type: event.payment.billingType ?? installment.billing_type,
        amount_cents:
          typeof event.payment.value === "number"
            ? Math.round(event.payment.value * 100)
            : fallbackAmount,
        due_date: event.payment.dueDate ?? installment.first_due_date,
        description: event.payment.description ?? installment.description,
        status: event.payment.status ?? "PENDING",
        invoice_url: event.payment.invoiceUrl ?? null,
        account_id: installment.account_id,
        account_plan_id: installment.account_plan_id,
        created_by_user_id: installment.created_by_user_id,
      };
      const inserted = await admin
        .from("asaas_payments")
        .insert(row)
        .select(
          "id, organization_id, asaas_payment_id, external_reference, status, financial_entry_id, reversal_entry_id",
        )
        .maybeSingle();

      if (inserted.error && inserted.error.code !== "23505") {
        await failEvent(event.id, inserted.error.message, installment.organization_id);
        return fail("internal_error", inserted.error.message, 500, { requestId });
      }
      if (inserted.data) {
        localPayment = inserted.data;
      } else {
        const existingGenerated = await admin
          .from("asaas_payments")
          .select(
            "id, organization_id, asaas_payment_id, external_reference, status, financial_entry_id, reversal_entry_id",
          )
          .eq("asaas_payment_id", event.payment.id)
          .maybeSingle();
        if (existingGenerated.error) {
          await failEvent(event.id, existingGenerated.error.message, installment.organization_id);
          return fail("internal_error", existingGenerated.error.message, 500, { requestId });
        }
        localPayment = existingGenerated.data;
      }
    }
  }

  // O Asaas pode enviar eventos de cobranças criadas fora do CRM. Elas não são
  // erro e não devem pausar a fila do webhook.
  if (!localPayment) {
    await finishEvent(event.id, { error: "payment_not_managed_by_crm" });
    return ok({ received: true, ignored: true }, { requestId });
  }

  const reconciliationEvents = new Set([
    "PAYMENT_PARTIALLY_REFUNDED",
    "PAYMENT_CHARGEBACK_REQUESTED",
    "PAYMENT_CHARGEBACK_DISPUTE",
    "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  ]);

  const updatePayload: Record<string, unknown> = {
    asaas_payment_id: event.payment.id,
    last_event_id: event.id,
    last_event_type: event.event,
    last_error: null,
    needs_reconciliation: reconciliationEvents.has(event.event),
  };

  if (event.payment.status) updatePayload.status = event.payment.status;
  if (event.payment.invoiceUrl) updatePayload.invoice_url = event.payment.invoiceUrl;

  const { error: syncError } = await admin
    .from("asaas_payments")
    .update(updatePayload)
    .eq("id", localPayment.id)
    .eq("organization_id", localPayment.organization_id);

  if (syncError) {
    await failEvent(event.id, syncError.message, localPayment.organization_id);
    return fail("internal_error", syncError.message, 500, { requestId });
  }

  try {
    if (event.event === "PAYMENT_RECEIVED") {
      // O payload do Asaas traz a data efetiva do pagamento. Usar o instante
      // em que o webhook chegou distorcia competência/caixa quando a entrega
      // fosse atrasada ou reprocessada.
      const paidDate = event.payment.paymentDate ?? event.payment.clientPaymentDate;
      const paidAt = paidDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(paidDate)
        ? `${paidDate}T00:00:00.000Z`
        : new Date().toISOString();

      const { data, error } = await admin.rpc("fn_asaas_payment_received", {
        p_local_payment: localPayment.id,
        p_paid_at: paidAt,
      });
      if (error) throw new Error(error.message);

      const result = (data ?? {}) as { entry_id?: string | null; created?: boolean };
      if (result.created && result.entry_id) {
        await audit({
          action: "financeiro.lancamento_criado",
          organizationId: localPayment.organization_id,
          resourceType: "financial_entry",
          resourceId: result.entry_id,
          requestId,
          metadata: {
            origin: "asaas",
            event_id: event.id,
            asaas_payment_id: event.payment.id,
            status: "paid",
          },
        });
      }
    }

    if (
      event.event === "PAYMENT_REFUNDED" ||
      event.event === "PAYMENT_RECEIVED_IN_CASH_UNDONE"
    ) {
      const { data, error } = await admin.rpc("fn_asaas_payment_refunded", {
        p_local_payment: localPayment.id,
        p_refunded_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);

      const result = (data ?? {}) as { entry_id?: string | null; created?: boolean };
      if (result.created && result.entry_id) {
        await audit({
          action: "financeiro.lancamento_criado",
          organizationId: localPayment.organization_id,
          resourceType: "financial_entry",
          resourceId: result.entry_id,
          requestId,
          metadata: {
            origin: "reversal",
            event_id: event.id,
            asaas_payment_id: event.payment.id,
            reason: event.event,
          },
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "asaas_webhook_processing_failed";
    await failEvent(event.id, message, localPayment.organization_id);
    return fail("internal_error", message, 500, { requestId });
  }

  await finishEvent(event.id, { organization_id: localPayment.organization_id });
  return ok({ received: true, processed: true }, { requestId });
}
