import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { Pagamentos } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pagamentos" };

export default async function PagamentosPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Pagamentos")}</h1>
        <p className="text-sm text-text-muted">
          {t("Crie cobranças pelo Asaas e acompanhe o que está pendente, pago ou vencido.")}
        </p>
      </div>
      <Pagamentos podeCobrar={ROLE_RANK[org.role] >= ROLE_RANK.agent} />
    </div>
  );
}
