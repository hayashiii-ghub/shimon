import { describe, expect, test } from "bun:test";

import { sanitizeDiagnosticText } from "../src/diagnostics.ts";

describe("sanitizeDiagnosticText", () => {
  test("redacts URL credentials, queries, fragments, and common secret fields", () => {
    const result = sanitizeDiagnosticText(
      "fetch https://user:pass@127.0.0.1/api?token=url-secret#trace Authorization: Bearer abc123 password=hunter2 token=loose-secret",
    );

    expect(result).toContain("https://127.0.0.1/api");
    expect(result).not.toContain("user:pass@");
    expect(result).not.toContain("url-secret");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("loose-secret");
    expect(result).toContain("[redacted]");
  });

  test("bounds individual diagnostic messages", () => {
    const result = sanitizeDiagnosticText("x".repeat(2_000));

    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.endsWith("…")).toBe(true);
  });
});
