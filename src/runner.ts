import { chromium } from "playwright";

import type { JsonValue } from "./canonicalize.ts";
import { ShimonError } from "./errors.ts";
import type { FingerprintArtifact, ShimonConfig } from "./types.ts";
import { publicTargetUrl } from "./url.ts";
import { TOOL_VERSION } from "./version.ts";

const FREEZE_STYLES = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition: none !important;
  }
`;

function asJsonValue(value: unknown, path = "probe"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((child, index) => asJsonValue(child, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ShimonError("probe_invalid", `${path} must be a plain JSON object.`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, asJsonValue(child, `${path}.${key}`)]),
    );
  }
  throw new ShimonError(
    "probe_invalid",
    `${path} is not JSON-serializable.`,
    "Return only objects, arrays, strings, finite numbers, booleans, or null from probe().",
  );
}

async function settle(page: import("playwright").Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function captureFingerprint(config: ShimonConfig): Promise<FingerprintArtifact> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: config.target.viewport });
    const page = await context.newPage();
    const recordedUrl = publicTargetUrl(config.target.url);

    let response: Awaited<ReturnType<typeof page.goto>>;
    try {
      response = await page.goto(config.target.url, { waitUntil: "load" });
    } catch (error) {
      throw new ShimonError("target_navigation_failed", `Could not load target: ${recordedUrl}`, undefined, {
        cause: error,
      });
    }
    if (response && !response.ok()) {
      throw new ShimonError(
        "target_http_error",
        `Target returned HTTP ${response.status()}: ${recordedUrl}`,
      );
    }

    await page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);

    if (config.freezeAnimations) {
      await page.addStyleTag({ content: FREEZE_STYLES });
    }

    await page.evaluate(() => document.fonts.ready);
    await config.stabilize?.(page);
    await settle(page);

    const runtime = await page.evaluate(() => ({
      deviceScaleFactor: window.devicePixelRatio,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));

    const cases: FingerprintArtifact["cases"] = [];
    for (const testCase of config.cases) {
      await testCase.prepare?.(page);
      await settle(page);
      const probe = asJsonValue(await config.probe(page), `cases.${testCase.name}.probe`);
      cases.push({ name: testCase.name, probe });
    }

    return {
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      target: { url: recordedUrl },
      environment: {
        browser: "chromium",
        browserVersion: browser.version(),
        viewport: config.target.viewport,
        deviceScaleFactor: runtime.deviceScaleFactor,
        locale: runtime.locale,
        timezone: runtime.timezone,
      },
      cases,
    };
  } finally {
    await browser.close();
  }
}
