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

  test("loads managed server and timeout budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        webServer: { command: "bun run dev", url: "http://127.0.0.1:4322/" },
        timeouts: { runMs: 90000, caseMs: 15000, navigationMs: 5000 },
        cases: [{ name: "start" }],
        probe: async () => ({}),
      };`,
    );

    const loaded = await loadConfig({ cwd: root });

    expect(loaded.config.webServer).toEqual({
      command: "bun run dev",
      url: "http://127.0.0.1:4322/",
      reuseExisting: true,
      timeoutMs: 30_000,
    });
    expect(loaded.config.timeouts).toEqual({
      runMs: 90_000,
      caseMs: 15_000,
      navigationMs: 5_000,
    });
  });
});
