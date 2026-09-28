import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import {
  AsaasApiError,
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

  if (parsed.data.contact_id) {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", parsed.data.contact_id)
      .maybeSingle();
    if (contactError) return fail("internal_error", contactError.message, 500, { requestId });
    if (!contact) {
      return fail("validation_failed", "Contato não pertence a esta organização.", 422, {
        requestId,
      });
    }
  }

  try {
    let linkedRow: { id: string; asaas_customer_id: string } | null = null;

    if (parsed.data.contact_id) {
      const { data: linked, error: linkedError } = await supabase
        .from("asaas_customers")
        .select("id, asaas_customer_id")
        .eq("organization_id", authz.org.orgId)
        .eq("contact_id", parsed.data.contact_id)
        .maybeSingle();

      if (linkedError) {
        return fail("internal_error", linkedError.message, 500, { requestId });
      }

      linkedRow = linked as typeof linkedRow;
      if (linkedRow?.asaas_customer_id) {
        try {
          const customer = await getAsaasCustomer(linkedRow.asaas_customer_id);
          return ok({ customer, created: false, source: "local_link" }, { requestId });
        } catch {
          // O vínculo pode ter ficado órfão após exclusão manual no Asaas.
          // Guardamos o ID local para reatar a MESMA linha abaixo.
        }
      }
    }

    let customer = await findAsaasCustomerByCpfCnpj(parsed.data.cpfCnpj);
    let created = false;

    if (!customer) {
      try {
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
      } catch (error) {
        // Timeout/5xx não prova que a escrita falhou. Procura novamente pelo
        // documento antes de devolver erro, evitando duplicar o cliente num
        // segundo clique do operador.
        if (error instanceof AsaasApiError && error.status >= 500) {
          try {
            customer = await findAsaasCustomerByCpfCnpj(parsed.data.cpfCnpj);
          } catch {
            customer = null;
          }
        }
        if (!customer) throw error;
      }
    }

    if (parsed.data.contact_id) {
      const mutation = linkedRow
        ? supabase
            .from("asaas_customers")
            .update({
              asaas_customer_id: customer.id,
              created_by_user_id: authz.user.id,
            })
            .eq("id", linkedRow.id)
            .eq("organization_id", authz.org.orgId)
        : supabase.from("asaas_customers").insert({
            organization_id: authz.org.orgId,
            contact_id: parsed.data.contact_id,
            asaas_customer_id: customer.id,
            created_by_user_id: authz.user.id,
          });

      const { error } = await mutation;
      if (error) {
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
