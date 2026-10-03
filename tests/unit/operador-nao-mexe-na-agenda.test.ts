import { describe, expect, it } from "vitest";

import { ferramentasSegurasDoOperador } from "@/lib/agent-engine/agent/operator-turn";

describe("Operador não altera agenda de cliente", () => {
  it("remove escritas de agenda e preserva ferramentas internas", () => {
    expect(
      ferramentasSegurasDoOperador([
        "crm_get_contact",
        "crm_schedule_followup",
        "crm_cancel_appointment",
        "crm_reschedule_appointment",
        "crm_book_appointment",
        "crm_confirm_appointment",
      ]),
    ).toEqual(["crm_get_contact", "crm_schedule_followup"]);
  });

  it("não mexe numa lista sem ferramentas de agenda", () => {
    expect(ferramentasSegurasDoOperador(["crm_get_contact", "crm_manage_tags"])).toEqual([
      "crm_get_contact",
      "crm_manage_tags",
    ]);
  });
});
