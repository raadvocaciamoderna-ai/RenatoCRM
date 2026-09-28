import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { asaasConfig, listAsaasWebhooks, testAsaasConnection } from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  let config: ReturnType<typeof asaasConfig>;
  try {
    config = asaasConfig();
  } catch (error) {
    const mapped = describeAsaasError(error);
    return ok(
      {
        configured: false,
        connected: false,
        environment: "sandbox",
        webhook: {
          token_configured: false,
          remote_configured: false,
          url: null,
        },
        error: mapped.message,
      },
      { requestId },
    );
  }

  const webhookUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/v1/webhooks/asaas`;

  if (!config.configured) {
    return ok(
      {
        configured: false,
        connected: false,
        environment: config.environment,
        webhook: {
          token_configured: config.webhookTokenConfigured,
          remote_configured: false,
          url: webhookUrl,
        },
        error: null,
      },
      { requestId },
    );
  }

  let connected = false;
  let error: string | null = null;
  try {
    await testAsaasConnection();
    connected = true;
  } catch (cause) {
    error = describeAsaasError(cause).message;
  }

  let remoteWebhookConfigured = false;
  if (connected && config.webhookTokenConfigured) {
    try {
      const webhooks = await listAsaasWebhooks();
      remoteWebhookConfigured = webhooks.some(
        (item) => item.url === webhookUrl && item.enabled !== false,
      );
    } catch {
      // Falha de leitura do catálogo de webhooks não transforma uma chave válida
      // em "desconectada". A configuração pode ser refeita pelo endpoint próprio.
    }
  }

  return ok(
    {
      configured: config.configured,
      connected,
      environment: config.environment,
      webhook: {
        token_configured: config.webhookTokenConfigured,
        remote_configured: remoteWebhookConfigured,
        url: webhookUrl,
      },
      error,
    },
    { requestId },
  );
}
