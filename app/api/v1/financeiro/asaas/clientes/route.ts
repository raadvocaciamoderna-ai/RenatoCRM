import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import {
  createAsaasCustomer,
  findAsaasCustomerByCpfCnpj,
  getAsaasCustomer,
} from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { criarClienteAsaasSchema } from "@/lib/asaas/schemas";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const parsed = criarClienteAsaasSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail(
      "validation_failed",
      parsed.error.issues[0]?.message ?? "Corpo inválido.",
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  try {
    if (parsed.data.contact_id) {
      const { data: linked } = await supabase
        .from("asaas_customers")
        .select("asaas_customer_id")
        .eq("organization_id", authz.org.orgId)
        .eq("contact_id", parsed.data.contact_id)
        .maybeSingle();

      if (linked?.asaas_customer_id) {
        try {
          const customer = await getAsaasCustomer(linked.asaas_customer_id as string);
          return ok({ customer, created: false, source: "local_link" }, { requestId });
        } catch {
          // O vínculo pode ter ficado órfão após exclusão manual no Asaas.
          // Nesse caso seguimos pela busca por CPF/CNPJ e reatamos abaixo.
        }
      }
    }

    let customer = await findAsaasCustomerByCpfCnpj(parsed.data.cpfCnpj);
    let created = false;

    if (!customer) {
      customer = await createAsaasCustomer({
        name: parsed.data.name,
        cpfCnpj: parsed.data.cpfCnpj,
        ...(parsed.data.email ? { email: parsed.data.email } : {}),
        ...(parsed.data.mobilePhone ? { mobilePhone: parsed.data.mobilePhone } : {}),
        ...(parsed.data.contact_id
          ? { externalReference: `crm-contact:${parsed.data.contact_id}` }
          : {}),
      });
      created = true;
    }

    if (parsed.data.contact_id) {
      const { error } = await supabase.from("asaas_customers").upsert(
        {
          organization_id: authz.org.orgId,
          contact_id: parsed.data.contact_id,
          asaas_customer_id: customer.id,
          created_by_user_id: authz.user.id,
        },
        { onConflict: "organization_id,asaas_customer_id" },
      );

      if (error && error.code !== "23505") {
        return fail("internal_error", error.message, 500, { requestId });
      }
    }

    return ok({ customer, created, source: created ? "created" : "cpf_cnpj" }, {
      status: created ? 201 : 200,
      requestId,
    });
  } catch (error) {
    const mapped = describeAsaasError(error);
    return fail(mapped.code, mapped.message, mapped.status, { requestId });
  }
}
