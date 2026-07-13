import { describe, expect, test } from "bun:test";

import { publicTargetUrl } from "../src/url.ts";

describe("publicTargetUrl", () => {
  test("removes credentials, query, and fragment from recorded HTTP URLs", () => {
    expect(publicTargetUrl("https://user:secret@127.0.0.1/demo?token=private#panel")).toBe(
      "https://127.0.0.1/demo",
    );
  });
});
