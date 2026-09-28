import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { upsertAsaasWebhook } from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { configurarWebhookAsaasSchema } from "@/lib/asaas/schemas";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const parsed = configurarWebhookAsaasSchema.safeParse(
    await req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return fail(
      "validation_failed",
      parsed.error.issues[0]?.message ?? "Corpo inválido.",
      422,
      { requestId },
    );
  }

  const webhookUrl =
    `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/v1/webhooks/asaas`;

  try {
    const result = await upsertAsaasWebhook({
      email: parsed.data.email,
      url: webhookUrl,
    });

    return ok(
      {
        created: result.created,
        id: result.webhook.id,
        url: result.webhook.url ?? webhookUrl,
        enabled: result.webhook.enabled ?? true,
      },
      { status: result.created ? 201 : 200, requestId },
    );
  } catch (error) {
    const mapped = describeAsaasError(error);
    return fail(mapped.code, mapped.message, mapped.status, { requestId });
  }
}
