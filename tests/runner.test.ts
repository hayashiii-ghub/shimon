import { describe, expect, test } from "bun:test";

import { captureFingerprint } from "../src/runner.ts";
import type { ShimonConfig } from "../src/types.ts";

describe("captureFingerprint", () => {
  test("isolates cases and records each case viewport", async () => {
    const html = `<!doctype html><button id="change" onclick="document.body.dataset.value = 'changed'">change</button>`;
    const config: ShimonConfig = {
      target: {
        url: `data:text/html,${encodeURIComponent(html)}`,
        viewport: { width: 640, height: 480 },
      },
      freezeAnimations: true,
      cases: [
        { name: "changed", prepare: (page) => page.locator("#change").click() },
        { name: "fresh", viewport: { width: 390, height: 844 } },
      ],
      probe: (page) =>
        page.evaluate(() => ({
          value: document.body.dataset.value ?? "initial",
          width: window.innerWidth,
        })),
    };

    const artifact = await captureFingerprint(config);

    expect(artifact.cases).toEqual([
      {
        name: "changed",
        viewport: { width: 640, height: 480 },
        probe: { value: "changed", width: 640 },
      },
      {
        name: "fresh",
        viewport: { width: 390, height: 844 },
        probe: { value: "initial", width: 390 },
      },
    ]);
  });

  test("runs named cases in order and records project-defined probes", async () => {
    const html = `<!doctype html><style>#value { animation: drift 1s infinite } @keyframes drift { to { opacity: .5 } }</style>
      <button id="step" onclick="document.querySelector('#value').textContent = '1'">step</button>
      <output id="value">0</output>`;

    const config: ShimonConfig = {
      target: {
        url: `data:text/html,${encodeURIComponent(html)}`,
        viewport: { width: 640, height: 480 },
      },
      freezeAnimations: true,
      stabilize: async (page) => {
        await page.evaluate(() => document.documentElement.setAttribute("data-stable", "yes"));
      },
      cases: [
        { name: "start" },
        { name: "stepped", prepare: async (page) => page.locator("#step").click() },
      ],
      probe: (page) =>
        page.evaluate(() => ({
          stable: document.documentElement.getAttribute("data-stable"),
          value: document.querySelector("#value")?.textContent ?? null,
          animation: getComputedStyle(document.querySelector("#value")!).animationName,
        })),
    };

    const artifact = await captureFingerprint(config);

    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.target.url).toBe("data:");
    expect(artifact.environment.viewport).toEqual({ width: 640, height: 480 });
    expect(artifact.cases).toEqual([
      {
        name: "start",
        viewport: { width: 640, height: 480 },
        probe: { animation: "none", stable: "yes", value: "0" },
      },
      {
        name: "stepped",
        viewport: { width: 640, height: 480 },
        probe: { animation: "none", stable: "yes", value: "1" },
      },
    ]);
  });

  test(
    "allows project stabilization when the page never reaches network idle",
    async () => {
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/poll") {
            return new Promise<Response>(() => {});
          }
          return new Response('<script>fetch("/poll")</script><main>ready</main>', {
            headers: { "content-type": "text/html" },
          });
        },
      });

      try {
        const startedAt = performance.now();
        const artifact = await captureFingerprint({
          target: {
            url: `http://127.0.0.1:${server.port}/`,
            viewport: { width: 640, height: 480 },
          },
          freezeAnimations: true,
          cases: [{ name: "ready" }],
          probe: (page) => page.evaluate(() => ({ text: document.querySelector("main")?.textContent ?? null })),
        });

        expect(artifact.cases[0]).toEqual({
          name: "ready",
          viewport: { width: 640, height: 480 },
          probe: { text: "ready" },
        });
        expect(performance.now() - startedAt).toBeLessThan(5_000);
      } finally {
        server.stop(true);
      }
    },
    35_000,
  );
});
