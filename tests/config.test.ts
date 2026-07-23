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

  test("loads a project-owned skeleton without cases or a probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        viewports: {
          desktop: { width: 1440, height: 900 },
          tablet: { width: 768, height: 1024 },
          mobile: { width: 390, height: 844 },
        },
      };`,
    );

    const loaded = await loadConfig({ cwd: root });

    expect(loaded.config.cases).toEqual([]);
    expect(await loaded.config.probe({} as never)).toEqual({});
  });

  test("resolves named viewports and preserves agent-authored case metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        viewports: {
          desktop: { width: 1440, height: 900 },
          tablet: { width: 768, height: 1024 },
          mobile: { width: 390, height: 844 },
        },
        cases: [{
          name: "pricing-mobile",
          path: "/pricing",
          viewport: "mobile",
          intent: "Verify the pricing cards stack without hiding the CTA.",
          review: ["Cards are readable", "CTA remains visually prominent"],
        }],
        probe: async () => ({}),
      };`,
    );

    const loaded = await loadConfig({ cwd: root });

    expect(loaded.config.viewports).toEqual({
      desktop: { width: 1440, height: 900 },
      tablet: { width: 768, height: 1024 },
      mobile: { width: 390, height: 844 },
    });
    expect(loaded.config.cases[0]).toMatchObject({
      name: "pricing-mobile",
      path: "/pricing",
      viewport: { width: 390, height: 844 },
      viewportName: "mobile",
      intent: "Verify the pricing cards stack without hiding the CTA.",
      review: ["Cards are readable", "CTA remains visually prominent"],
    });
  });

  test("rejects an unknown named viewport", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        viewports: { mobile: { width: 390, height: 844 } },
        cases: [{ name: "start", viewport: "tablet" }],
        probe: async () => ({}),
      };`,
    );

    await expect(loadConfig({ cwd: root })).rejects.toThrow(
      'cases[0].viewport references unknown viewport "tablet"',
    );
  });

  test("rejects a case path that can escape to another origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        cases: [{ name: "external", path: "//example.com/" }],
      };`,
    );

    await expect(loadConfig({ cwd: root })).rejects.toThrow(
      'cases[0].path must be a project-relative path starting with a single "/"',
    );
  });

  test("preserves project checks and rejects duplicate check ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-config-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "http://127.0.0.1:4322/" },
        cases: [{
          name: "pricing",
          checks: [
            { id: "cta-visible", description: "The CTA is visible", evaluate: async () => true },
            { id: "cta-visible", description: "Duplicate", evaluate: async () => true },
          ],
        }],
        probe: async () => ({}),
      };`,
    );

    await expect(loadConfig({ cwd: root })).rejects.toThrow("Duplicate check id in case pricing: cta-visible");
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
