import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  test("loads the default config and applies viewport defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        cases: [{ name: "start" }],
        probe: async () => ({ ok: true }),
      };`,
    );

    const loaded = await loadConfig({ cwd: root });

    expect(loaded.path).toBe(join(root, "shimon.config.mjs"));
    expect(loaded.config.target.viewport).toEqual({ width: 1200, height: 900 });
  });

  test("rejects duplicate case names", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        cases: [{ name: "same" }, { name: "same" }],
        probe: async () => ({}),
      };`,
    );

    await expect(loadConfig({ cwd: root })).rejects.toThrow("Duplicate case name");
  });
});
