import { AsaasApiError, AsaasConfigError } from "@/lib/asaas/client";

export function describeAsaasError(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (error instanceof AsaasConfigError) {
    return { code: "asaas_not_configured", message: error.message, status: 503 };
  }

  if (error instanceof AsaasApiError) {
    if (error.status === 400 || error.status === 422) {
      return { code: "asaas_validation_failed", message: error.message, status: 422 };
    }
    if (error.status === 404) {
      return { code: "asaas_not_found", message: error.message, status: 404 };
    }
    if (error.status === 429) {
      return {
        code: "asaas_rate_limited",
        message: "O Asaas limitou temporariamente as requisições. Tente novamente em instantes.",
        status: 503,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        code: "asaas_auth_failed",
        message: "A credencial do Asaas foi recusada. Confira a chave e o ambiente configurados.",
        status: 502,
      };
    }
    return { code: "asaas_unavailable", message: error.message, status: 502 };
  }

  return {
    code: "asaas_unavailable",
    message: error instanceof Error ? error.message : "Falha inesperada na integração com o Asaas.",
    status: 502,
  };
}
