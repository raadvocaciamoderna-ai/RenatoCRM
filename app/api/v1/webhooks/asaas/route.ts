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
      const { data, error } = await admin.rpc("fn_asaas_payment_received", {
        p_local_payment: localPayment.id,
        p_paid_at: new Date().toISOString(),
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
