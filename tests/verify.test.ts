import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import type { ShimonConfig } from "../src/types.ts";
import { verifyProject } from "../src/verify.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verifyProject", () => {
  test("manages the configured web server around the verification run", async () => {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
    const port = reservation.port;
    reservation.stop(true);
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const script = join(root, "server.ts");
    await writeFile(
      script,
      `Bun.serve({ port: ${port}, fetch: () => new Response('<html lang="en"><head><title>managed</title></head><body><main><h1>ready</h1></main></body></html>', { headers: { "content-type": "text/html" } }) });`,
    );
    const url = `http://127.0.0.1:${port}/`;
    const config: ShimonConfig = {
      target: { url, viewport: { width: 320, height: 240 } },
      webServer: {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        url,
        reuseExisting: true,
        timeoutMs: 5_000,
      },
      freezeAnimations: true,
      cases: [{ name: "managed" }],
      probe: () => ({ ready: true }),
    };

    const result = await verifyProject(config, { root, cwd: root });

    expect(result.pass).toBeTrue();
    expect(result.run.webServer).toEqual({ managed: true, reused: false });
    await expect(fetch(url)).rejects.toThrow();
  }, 30_000);

  test("rejects an unknown selected case", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: { url: "data:text/html,<h1>hello</h1>", viewport: { width: 320, height: 240 } },
      freezeAnimations: true,
      cases: [{ name: "home" }],
      probe: () => ({}),
    };

    await expect(verifyProject(config, { root, caseNames: ["missing"] })).rejects.toMatchObject({
      code: "case_not_found",
    });
  });

  test("continues after a case execution error", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: {
        url: `data:text/html,${encodeURIComponent('<html lang="en"><head><title>cases</title></head><body><main><h1>ready</h1></main></body></html>')}`,
        viewport: { width: 320, height: 240 },
      },
      freezeAnimations: true,
      cases: [
        {
          name: "broken",
          prepare: () => {
            throw new Error(
              "cannot prepare https://user:pass@127.0.0.1/state?token=url-secret#trace Authorization: Bearer abc123",
            );
          },
        },
        { name: "ready" },
      ],
      probe: () => ({ ready: true }),
    };

    const result = await verifyProject(config, { root });

    expect(result.pass).toBeFalse();
    expect(result.cases[0]).toMatchObject({
      name: "broken",
      pass: false,
      error: { code: "case_execution_failed" },
    });
    expect(result.cases[0].error?.message).toContain("cannot prepare https://127.0.0.1/state");
    expect(result.cases[0].error?.message).not.toContain("url-secret");
    expect(result.cases[0].error?.message).not.toContain("abc123");
    expect(result.cases[1]).toMatchObject({ name: "ready", pass: true });
    expect(result.summary).toEqual({ total: 2, passed: 1, failed: 1 });
    expect((await stat(result.cases[1].evidence.screenshot!)).size).toBeGreaterThan(0);
  }, 30_000);

  test("bounds a case whose project hook never resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: {
        url: `data:text/html,${encodeURIComponent('<html lang="en"><head><title>timeout</title></head><body><main><h1>ready</h1></main></body></html>')}`,
        viewport: { width: 320, height: 240 },
      },
      timeouts: { runMs: 1_000, caseMs: 100, navigationMs: 500 },
      freezeAnimations: true,
      cases: [{ name: "hanging", prepare: () => new Promise<void>(() => undefined) }],
      probe: () => ({}),
    };

    const startedAt = Date.now();
    const result = await verifyProject(config, { root });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.cases[0]).toMatchObject({
      name: "hanging",
      pass: false,
      error: { code: "case_timeout" },
    });
  }, 2_000);

  test("reports the run budget separately from a case timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: {
        url: `data:text/html,${encodeURIComponent('<html lang="en"><head><title>run timeout</title></head><body><main><h1>ready</h1></main></body></html>')}`,
        viewport: { width: 320, height: 240 },
      },
      timeouts: { runMs: 500, caseMs: 5_000, navigationMs: 500 },
      freezeAnimations: true,
      cases: [{ name: "hanging", prepare: () => new Promise<void>(() => undefined) }],
      probe: () => ({}),
    };

    await expect(verifyProject(config, { root })).rejects.toMatchObject({ code: "run_timeout" });
  }, 2_000);

  test("includes managed-server startup in the run budget", async () => {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
    const port = reservation.port;
    reservation.stop(true);
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const script = join(root, "never-ready.ts");
    await writeFile(script, "setInterval(() => undefined, 1_000);");
    const config: ShimonConfig = {
      target: { url: `http://127.0.0.1:${port}/`, viewport: { width: 320, height: 240 } },
      webServer: {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        url: `http://127.0.0.1:${port}/`,
        reuseExisting: true,
        timeoutMs: 1_000,
      },
      timeouts: { runMs: 150, caseMs: 5_000, navigationMs: 500 },
      freezeAnimations: true,
      cases: [{ name: "home" }],
      probe: () => ({}),
    };

    const startedAt = Date.now();
    await expect(verifyProject(config, { root, cwd: root })).rejects.toMatchObject({
      code: "run_timeout",
    });
    expect(Date.now() - startedAt).toBeLessThan(750);
  }, 2_000);

  test("returns a clean case with checks, probe, and screenshot evidence", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          '<!doctype html><html lang="en"><head><title>clean</title></head><body><main><h1>Hello</h1></main></body></html>',
          { headers: { "content-type": "text/html" } },
        ),
    });
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: { url: `http://127.0.0.1:${server.port}/`, viewport: { width: 640, height: 480 } },
      freezeAnimations: true,
      cases: [{ name: "home" }],
      probe: (page) => page.evaluate(() => ({ heading: document.querySelector("h1")?.textContent ?? null })),
    };

    try {
      const result = await verifyProject(config, { root });
      const verifiedCase = result.cases[0];

      expect(result.success).toBeTrue();
      expect(result.pass).toBeTrue();
      expect(result.summary).toEqual({ total: 1, passed: 1, failed: 0 });
      expect(verifiedCase.probe).toEqual({ heading: "Hello" });
      expect(verifiedCase.checks?.overflow.pass).toBeTrue();
      expect(verifiedCase.checks?.consoleErrors.pass).toBeTrue();
      expect(verifiedCase.checks?.failedRequests.pass).toBeTrue();
      expect(verifiedCase.checks?.a11y.pass).toBeTrue();
      expect((await stat(verifiedCase.evidence.screenshot!)).size).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(result.manifest, "utf8"))).toMatchObject({
        success: true,
        pass: true,
      });
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("returns actionable evidence for overflow, console, request, and a11y failures", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/missing.png") {
          return new Response("missing", { status: 404 });
        }
        return new Response(
          `<!doctype html><html lang="en"><head><title>bad</title></head><body style="margin:0">
            <div id="wide" style="width:1200px">wide</div>
            <img src="/missing.png?token=secret">
            <script>console.error("boom")</script>
          </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: { url: `http://127.0.0.1:${server.port}/`, viewport: { width: 390, height: 844 } },
      freezeAnimations: true,
      cases: [{ name: "bad" }],
      probe: () => ({ state: "bad" }),
    };

    try {
      const result = await verifyProject(config, { root });
      const verifiedCase = result.cases[0];

      expect(result.pass).toBeFalse();
      expect(verifiedCase.checks?.overflow.offenders[0]).toMatchObject({
        selector: "div#wide",
        box: { width: 1200 },
      });
      expect(verifiedCase.checks?.consoleErrors.messages).toContain("boom");
      expect(verifiedCase.checks?.failedRequests.requests).toContainEqual({
        url: `http://127.0.0.1:${server.port}/missing.png`,
        method: "GET",
        resourceType: "image",
        status: 404,
        error: null,
      });
      expect(verifiedCase.checks?.a11y.violations).toContainEqual(
        expect.objectContaining({ id: "image-alt", targets: ["img"] }),
      );
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("masks sensitive elements in screenshot evidence", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          '<!doctype html><html lang="en"><head><title>masked</title></head><body style="margin:0"><main><h1 id="secret" style="margin:0;width:100px;height:100px;background:#ff0000;color:#ff0000">secret</h1></main></body></html>',
          { headers: { "content-type": "text/html" } },
        ),
    });
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: { url: `http://127.0.0.1:${server.port}/`, viewport: { width: 320, height: 240 } },
      freezeAnimations: true,
      screenshot: { mask: ["#secret"] },
      cases: [{ name: "masked" }],
      probe: (page) =>
        page.evaluate(() => ({ secret: document.querySelector("#secret")?.textContent ?? null })),
    };

    try {
      const result = await verifyProject(config, { root });
      const png = (await readFile(result.cases[0].evidence.screenshot!)).toString("base64");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pixel = await page.evaluate(async (source) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return [...context.getImageData(50, 50, 1, 1).data];
        }, `data:image/png;base64,${png}`);
        expect(pixel).toEqual([0, 0, 0, 255]);
      } finally {
        await browser.close();
      }
      expect(result.cases[0].probe).toEqual({ secret: "secret" });
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
