"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

type AsaasStatus = {
  configured: boolean;
  connected: boolean;
  environment: "sandbox" | "production";
  webhook: {
    token_configured: boolean;
    remote_configured: boolean;
    url: string | null;
  };
  error: string | null;
};

export function AsaasIntegracao({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");

  const status = useQuery({
    queryKey: ["financeiro", "asaas", "status"],
    queryFn: async () =>
      (await apiClient.get<{ data: AsaasStatus }>("/api/v1/financeiro/asaas/status")).data,
  });

  const configurarWebhook = useMutation({
    mutationFn: () =>
      apiClient.post("/api/v1/financeiro/asaas/webhook", { email: email.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["financeiro", "asaas", "status"] });
    },
    onError: showApiError,
  });

  const dados = status.data;
  const ambiente =
    dados?.environment === "production" ? t("Produção") : t("Sandbox");

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="asaas-integracao">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("Asaas")}</h2>
          <p className="text-sm text-text-muted">
            {t("Cobranças Pix, boleto e cartão integradas ao financeiro do CRM.")}
          </p>
        </div>
        {dados ? (
          <span className="rounded-full border px-2 py-1 text-xs">
            {ambiente}
          </span>
        ) : null}
      </div>

      {status.isLoading ? <p className="text-sm">{t("Verificando conexão…")}</p> : null}

      {status.isError ? (
        <p className="text-sm text-destructive">
          {t("Não foi possível verificar a integração do Asaas.")}
        </p>
      ) : null}

      {dados ? (
        <div className="space-y-2 text-sm">
          <p>
            <strong>{t("API")}:</strong>{" "}
            {dados.connected
              ? t("conectada")
              : dados.configured
                ? t("configurada, mas a conexão falhou")
                : t("não configurada")}
          </p>
          <p>
            <strong>{t("Webhook")}:</strong>{" "}
            {dados.webhook.remote_configured
              ? t("configurado")
              : dados.webhook.token_configured
                ? t("token pronto; falta registrar no Asaas")
                : t("token não configurado")}
          </p>

          {dados.error ? <p className="text-destructive">{dados.error}</p> : null}

          {!dados.configured ? (
            <p className="text-text-muted">
              {t("Defina ASAAS_API_KEY na VPS para ativar a integração.")}
            </p>
          ) : null}

          {dados.configured && !dados.webhook.token_configured ? (
            <p className="text-text-muted">
              {t("Defina ASAAS_WEBHOOK_TOKEN na VPS para receber confirmações de pagamento.")}
            </p>
          ) : null}

          {podeEditar && dados.connected && dados.webhook.token_configured ? (
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <input
                type="email"
                aria-label={t("E-mail para alertas do webhook")}
                className="min-h-11 min-w-64 rounded-md border p-2"
                placeholder={t("E-mail para alertas do Asaas")}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button
                className="min-h-11"
                disabled={
                  !email.trim().includes("@") ||
                  configurarWebhook.isPending
                }
                onClick={() => configurarWebhook.mutate()}
              >
                {dados.webhook.remote_configured
                  ? t("Atualizar webhook")
                  : t("Configurar webhook")}
              </Button>
            </div>
          ) : null}

          {dados.webhook.url ? (
            <p className="break-all text-xs text-text-muted">
              {t("URL do webhook")}: {dados.webhook.url}
            </p>
          ) : null}
        </div>
      ) : null}

      <Button
        variant="ghost"
        className="min-h-11"
        disabled={status.isFetching}
        onClick={() => void status.refetch()}
      >
        {t("Testar conexão")}
      </Button>
    </section>
  );
}
