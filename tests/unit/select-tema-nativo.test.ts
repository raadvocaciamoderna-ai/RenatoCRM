import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

describe("select nativo acompanha o tema", () => {
  it("define superfície e texto para option e optgroup", () => {
    expect(CSS).toMatch(
      /select option,\s*select optgroup\s*\{[\s\S]*?background-color:\s*var\(--color-surface\);[\s\S]*?color:\s*var\(--color-text\);/,
    );
  });

  it("reforça color-scheme nos temas claro e escuro", () => {
    expect(CSS).toMatch(
      /\[data-theme="dark"\] select,[\s\S]*?color-scheme:\s*dark;/,
    );
    expect(CSS).toMatch(
      /\[data-theme="light"\] select,[\s\S]*?color-scheme:\s*light;/,
    );
  });
});
