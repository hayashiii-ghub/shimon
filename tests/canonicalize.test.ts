import { describe, expect, test } from "bun:test";

import { canonicalStringify } from "../src/canonicalize.ts";

describe("canonicalStringify", () => {
  test("sorts object keys recursively while preserving array order", () => {
    const value = {
      zebra: 1,
      alpha: { second: true, first: false },
      list: [{ y: 2, x: 1 }, "kept"],
    };

    expect(canonicalStringify(value)).toBe(
      '{"alpha":{"first":false,"second":true},"list":[{"x":1,"y":2},"kept"],"zebra":1}\n',
    );
  });
});
