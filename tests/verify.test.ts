import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import type { ShimonConfig } from "../src/types.ts";
import { verifyProject } from "../src/verify.ts";

const roots: string[] = [];

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function readPngPixel(png: Buffer, x: number, y: number): number[] {
  const signature = png.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") throw new Error("Screenshot evidence is not a PNG.");

  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("Unsupported PNG screenshot format.");
      bytesPerPixel = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (bytesPerPixel === 0) throw new Error("Unsupported PNG screenshot color type.");
    } else if (type === "IDAT") {
      compressed.push(data);
    }
    offset += length + 12;
  }
  if (x < 0 || x >= width || y < 0 || y >= height) throw new Error("PNG pixel is out of bounds.");

  const encoded = inflateSync(Buffer.concat(compressed));
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = encoded[source + column];
      const left = column >= bytesPerPixel ? pixels[target + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[target + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? pixels[target + column - stride - bytesPerPixel]
        : 0;
      const reconstructed = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paeth(left, above, upperLeft)
                : Number.NaN;
      if (Number.isNaN(reconstructed)) throw new Error(`Unsupported PNG filter: ${filter}.`);
      pixels[target + column] = reconstructed & 0xff;
    }
  }

  const offset = (y * width + x) * bytesPerPixel;
  const color = [...pixels.subarray(offset, offset + bytesPerPixel)];
  return bytesPerPixel === 3 ? [...color, 255] : color;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verifyProject", () => {
  test("requires an agent-authored case before starting a verification run", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: { url: "http://127.0.0.1:4322/", viewport: { width: 320, height: 240 } },
      freezeAnimations: true,
      cases: [],
    };

    await expect(verifyProject(config, { root })).rejects.toMatchObject({
      code: "cases_required",
      hint: expect.stringContaining("task config"),
    });
  });

  test("navigates to a case path and reports agent-authored intent, review, and project checks", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        return new Response(
          `<!doctype html><html lang="en"><head><title>pricing</title></head><body><main><h1>Pricing</h1><a id="cta" href="/buy">Buy</a><p>${url.pathname}</p></main></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: { url: `http://127.0.0.1:${server.port}/`, viewport: { width: 1440, height: 900 } },
      freezeAnimations: true,
      cases: [
        {
          name: "pricing-mobile",
          path: "/pricing?cycle=monthly",
          viewport: { width: 390, height: 844 },
          viewportName: "mobile",
          intent: "Verify the mobile pricing CTA.",
          review: ["Pricing hierarchy is clear", "CTA is visually prominent"],
          checks: [
            {
              id: "pricing-route",
              description: "The pricing route rendered",
              evaluate: (page) => page.evaluate(() => location.pathname === "/pricing"),
            },
            {
              id: "cta-width",
              description: "The CTA is wide enough to tap",
              evaluate: async (page) => ({
                pass: false,
                evidence: await page.locator("#cta").evaluate((node) => ({
                  text: node.textContent,
                  width: Math.round(node.getBoundingClientRect().width),
                })),
              }),
            },
          ],
        },
      ],
    };

    try {
      const result = await verifyProject(config, {
        root,
        configPath: "shimon.config.mjs",
        taskPath: ".shimon/task.mjs",
      });
      const verifiedCase = result.cases[0];

      expect(result.pass).toBeFalse();
      expect(result.visualReviewRequired).toBeTrue();
      expect(verifiedCase).toMatchObject({
        name: "pricing-mobile",
        url: `http://127.0.0.1:${server.port}/pricing`,
        viewport: { width: 390, height: 844 },
        viewportName: "mobile",
        intent: "Verify the mobile pricing CTA.",
        review: ["Pricing hierarchy is clear", "CTA is visually prominent"],
        reproduce:
          'shimon verify --case pricing-mobile --config "shimon.config.mjs" --task ".shimon/task.mjs" --json',
      });
      expect(verifiedCase.checks?.project).toEqual([
        {
          id: "pricing-route",
          description: "The pricing route rendered",
          pass: true,
        },
        {
          id: "cta-width",
          description: "The CTA is wide enough to tap",
          pass: false,
          evidence: { text: "Buy", width: expect.any(Number) },
        },
      ]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

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
      timeouts: { runMs: 5_000, caseMs: 100, navigationMs: 500 },
      freezeAnimations: true,
      cases: [{ name: "hanging", prepare: () => new Promise<void>(() => undefined) }],
    };

    const result = await verifyProject(config, { root });

    expect(result.cases[0]).toMatchObject({
      name: "hanging",
      pass: false,
      error: { code: "case_timeout" },
    });
  }, 5_000);

  test("reports the run budget separately from a case timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-verify-"));
    roots.push(root);
    const config: ShimonConfig = {
      target: {
        url: `data:text/html,${encodeURIComponent('<html lang="en"><head><title>run timeout</title></head><body><main><h1>ready</h1></main></body></html>')}`,
        viewport: { width: 320, height: 240 },
      },
      timeouts: { runMs: 2_000, caseMs: 5_000, navigationMs: 500 },
      freezeAnimations: true,
      cases: [{ name: "hanging", prepare: () => new Promise<void>(() => undefined) }],
    };

    await expect(verifyProject(config, { root })).rejects.toMatchObject({ code: "run_timeout" });
  }, 4_000);

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
    };

    const startedAt = Date.now();
    await expect(verifyProject(config, { root, cwd: root })).rejects.toMatchObject({
      code: "run_timeout",
    });
    expect(Date.now() - startedAt).toBeLessThan(750);
  }, 2_000);

  test("returns a clean case with checks and screenshot evidence", async () => {
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
    };

    try {
      const result = await verifyProject(config, { root });
      const verifiedCase = result.cases[0];

      expect(result.success).toBeTrue();
      expect(result.pass).toBeTrue();
      expect(result.visualReviewRequired).toBeTrue();
      expect(result.summary).toEqual({ total: 1, passed: 1, failed: 0 });
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
    };

    try {
      const result = await verifyProject(config, { root });
      const png = await readFile(result.cases[0].evidence.screenshot!);
      expect(readPngPixel(png, 50, 50)).toEqual([0, 0, 0, 255]);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
