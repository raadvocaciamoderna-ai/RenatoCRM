import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import { traduzir } from "@/lib/i18n/dicionario";
import { Gear, Users } from "@/lib/ui/icons";

import { Pagamentos } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pagamentos" };

export default async function PagamentosPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <header className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-text-muted">
            {t("Financeiro")} · Asaas
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("Pagamentos")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            {t("Crie cobranças para clientes do CRM, envie pelo WhatsApp e acompanhe recebimentos, atrasos e recorrências.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/app/contacts">
              <Users size={16} aria-hidden />
              {t("Clientes")}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/app/settings/tenant/financeiro">
              <Gear size={16} aria-hidden />
              {t("Configurações financeiras")}
            </Link>
          </Button>
        </div>
      </header>
      <Pagamentos podeCobrar={ROLE_RANK[org.role] >= ROLE_RANK.agent} />
    </div>
  );
}
