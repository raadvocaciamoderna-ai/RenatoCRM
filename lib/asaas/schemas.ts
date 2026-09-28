import { z } from "zod";

const cpfCnpj = z
  .string()
  .transform((value) => value.replace(/\D/g, ""))
  .refine((value) => value.length === 11 || value.length === 14, "CPF/CNPJ inválido.");

const telefone = z
  .string()
  .transform((value) => value.replace(/\D/g, ""))
  .refine((value) => value.length >= 10 && value.length <= 13, "Telefone inválido.");

export const criarClienteAsaasSchema = z.object({
  name: z.string().trim().min(2).max(150),
  cpfCnpj,
  email: z.string().trim().email().max(200).optional(),
  mobilePhone: telefone.optional(),
  contact_id: z.string().uuid().optional(),
});

export const criarCobrancaAsaasSchema = z.object({
  customer_id: z.string().trim().min(3).max(100),
  contact_id: z.string().uuid().optional(),
  billing_type: z.enum(["UNDEFINED", "BOLETO", "CREDIT_CARD", "PIX"]).default("PIX"),
  value_cents: z.number().int().min(1).max(1_000_000_000),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data de vencimento inválida."),
  description: z.string().trim().min(1).max(500).optional(),
  account_id: z.string().uuid(),
  account_plan_id: z.string().uuid().nullish(),
});

export const criarParcelamentoAsaasSchema = z.object({
  customer_id: z.string().trim().min(3).max(100),
  contact_id: z.string().uuid().optional(),
  billing_type: z.enum(["UNDEFINED", "BOLETO", "CREDIT_CARD", "PIX"]).default("PIX"),
  total_value_cents: z.number().int().min(2).max(1_000_000_000),
  installment_count: z.number().int().min(2).max(24),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data de vencimento inválida."),
  description: z.string().trim().min(1).max(500).optional(),
  account_id: z.string().uuid(),
  account_plan_id: z.string().uuid().nullish(),
});

export const criarAssinaturaAsaasSchema = z.object({
  customer_id: z.string().trim().min(3).max(100),
  contact_id: z.string().uuid().optional(),
  billing_type: z.enum(["UNDEFINED", "BOLETO", "CREDIT_CARD", "PIX"]).default("PIX"),
  value_cents: z.number().int().min(1).max(1_000_000_000),
  next_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data de vencimento inválida."),
  cycle: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "BIMONTHLY", "QUARTERLY", "SEMIANNUALLY", "YEARLY"]),
  description: z.string().trim().min(1).max(500).optional(),
  max_payments: z.number().int().min(1).max(240).optional(),
  account_id: z.string().uuid(),
  account_plan_id: z.string().uuid().nullish(),
});

export const configurarWebhookAsaasSchema = z.object({
  email: z.string().trim().email().max(200),
});

export const webhookAsaasSchema = z.object({
  id: z.string().min(3).max(255),
  event: z.string().min(3).max(120),
  dateCreated: z.string().optional(),
  payment: z
    .object({
      id: z.string().min(3).max(120),
      customer: z.string().optional(),
      status: z.string().optional(),
      billingType: z.string().optional(),
      value: z.number().optional(),
      netValue: z.number().optional(),
      dueDate: z.string().optional(),
      paymentDate: z.string().nullish(),
      clientPaymentDate: z.string().nullish(),
      invoiceUrl: z.string().url().nullish(),
      externalReference: z.string().nullish(),
      description: z.string().nullish(),
      installment: z.string().nullish(),
      subscription: z.string().nullish(),
      installmentNumber: z.number().int().positive().nullish(),
    })
    .passthrough(),
});

export type CriarClienteAsaasInput = z.infer<typeof criarClienteAsaasSchema>;
export type CriarCobrancaAsaasInput = z.infer<typeof criarCobrancaAsaasSchema>;
export type CriarParcelamentoAsaasInput = z.infer<typeof criarParcelamentoAsaasSchema>;
export type CriarAssinaturaAsaasInput = z.infer<typeof criarAssinaturaAsaasSchema>;
