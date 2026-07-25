import { describe, expect, test } from "bun:test";

import { asJsonValue } from "../src/json.ts";

describe("asJsonValue", () => {
  test("keeps JSON evidence", () => {
    expect(asJsonValue({ count: 2, values: [true, null, "ready"] })).toEqual({
      count: 2,
      values: [true, null, "ready"],
    });
  });

  test("rejects values that cannot be persisted as JSON", () => {
    expect(() => asJsonValue({ value: undefined })).toThrow("evidence.value is not JSON-serializable");
  });
});
