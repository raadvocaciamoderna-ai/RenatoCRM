import type { Metadata } from "next";

import { ContactsListClient } from "@/app/app/contacts/_client";
import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Clientes" };

export default function ClientsPage() {
  return (
    <ContactsListClient
      initialTag={TAG_DE_CLIENTE}
      title="Clientes"
      description="Visão dos clientes dentro da mesma base de Contatos, sem duplicar cadastros."
      clientsView
    />
  );
}
