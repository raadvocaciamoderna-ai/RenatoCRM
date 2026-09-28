import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  payment_id: z.string().uuid(),
});

function money(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function dataBr(value: string): string {
  const [y, m, d] = value.split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail("validation_failed", "Cobrança inválida.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: payment, error } = await admin
    .from("asaas_payments")
    .select("id, contact_id, amount_cents, due_date, description, invoice_url")
    .eq("id", parsed.data.payment_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!payment) return fail("not_found", "Cobrança não encontrada.", 404, { requestId });
  if (!payment.contact_id) {
    return fail(
      "validation_failed",
      "Esta cobrança não está vinculada a um contato do CRM.",
      422,
      { requestId },
    );
  }
  if (!payment.invoice_url) {
    return fail(
      "validation_failed",
      "O Asaas ainda não disponibilizou o link desta cobrança.",
      422,
      { requestId },
    );
  }

  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .select("id, name, display_name, phone_number")
    .eq("id", payment.contact_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (contactError) return fail("internal_error", contactError.message, 500, { requestId });
  if (!contact?.phone_number) {
    return fail("validation_failed", "O contato não possui telefone para WhatsApp.", 422, {
      requestId,
    });
  }

  try {
    const opened = await openSharedContactConversation(admin, authz.org.orgId, {
      contact_id: contact.id,
    });
    const nome = contact.name?.trim() || contact.display_name?.trim() || "Olá";
    const mensagem =
      `${nome}, segue sua cobrança de ${money(Number(payment.amount_cents))} ` +
      `com vencimento em ${dataBr(payment.due_date)}.\n\n` +
      `${payment.description ? `${payment.description}\n\n` : ""}` +
      `${payment.invoice_url}\n\nSe já realizou o pagamento, desconsidere esta mensagem.`;

    const sent = await sendMessageHandler(
      admin,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      {
        conversation_id: opened.conversation_id,
        type: "text",
        body: mensagem,
        metadata: {
          source: "asaas_payment",
          asaas_payment_local_id: payment.id,
        },
      },
    );

    return ok(
      {
        sent: true,
        conversation_id: opened.conversation_id,
        message_id: sent.id,
      },
      { requestId },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    const message = err instanceof Error ? err.message : "Falha ao enviar cobrança.";
    if (message === "session_not_found") {
      return fail("not_found", "Não há sessão de WhatsApp pronta para envio.", 404, { requestId });
    }
    return fail("internal_error", message, 500, { requestId });
  }
}
