import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { getAsaasPixQrCode } from "@/lib/asaas/client";
import { describeAsaasError } from "@/lib/asaas/http-error";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("asaas_payments")
    .select("asaas_payment_id, billing_type")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Cobrança Asaas não encontrada.", 404, { requestId });
  if (data.billing_type !== "PIX") {
    return fail("validation_failed", "Esta cobrança não é Pix.", 422, { requestId });
  }
  if (!data.asaas_payment_id) {
    return fail("conflict", "A cobrança ainda não foi sincronizada com o Asaas.", 409, {
      requestId,
    });
  }

  try {
    const pix = await getAsaasPixQrCode(data.asaas_payment_id as string);
    return ok(pix, { requestId });
  } catch (error) {
    const mapped = describeAsaasError(error);
    return fail(mapped.code, mapped.message, mapped.status, { requestId });
  }
}
