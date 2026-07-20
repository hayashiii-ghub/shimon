import { chromium } from "playwright";

import { runConfiguredCase } from "./case-runner.ts";
import { ShimonError } from "./errors.ts";
import type { FingerprintArtifact, ShimonConfig } from "./types.ts";
import { publicTargetUrl } from "./url.ts";
import { TOOL_VERSION } from "./version.ts";

export async function captureFingerprint(config: ShimonConfig): Promise<FingerprintArtifact> {
  const browser = await chromium.launch({ headless: true });
  try {
    const recordedUrl = publicTargetUrl(config.target.url);
    const cases: FingerprintArtifact["cases"] = [];
    let runtime: { deviceScaleFactor: number; locale: string; timezone: string } | undefined;
    for (const testCase of config.cases) {
      const viewport = testCase.viewport ?? config.target.viewport;
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
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

        runtime ??= await page.evaluate(() => ({
          deviceScaleFactor: window.devicePixelRatio,
          locale: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }));
        const probe = await runConfiguredCase(page, config, testCase);
        cases.push({ name: testCase.name, viewport, probe });
      } finally {
        await context.close();
      }
    }

    if (!runtime) throw new ShimonError("config_invalid", "At least one case is required.");

    return {
      schemaVersion: 2,
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
