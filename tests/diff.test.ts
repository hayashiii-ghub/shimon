import { describe, expect, test } from "bun:test";

import { diffJson } from "../src/diff.ts";

describe("diffJson", () => {
  test("reports nested additions, removals, and changes by path", () => {
    const before = {
      cases: [{ name: "start", probe: { opacity: 0, stale: true } }],
    };
    const after = {
      cases: [{ name: "start", probe: { opacity: 1, added: "yes" } }],
    };

    expect(diffJson(before, after)).toEqual([
      { path: "cases[0].probe.added", before: undefined, after: "yes" },
      { path: "cases[0].probe.opacity", before: 0, after: 1 },
      { path: "cases[0].probe.stale", before: true, after: undefined },
    ]);
  });

  test("returns no changes for equal values", () => {
    expect(diffJson({ stable: [1, 2] }, { stable: [1, 2] })).toEqual([]);
  });
});
