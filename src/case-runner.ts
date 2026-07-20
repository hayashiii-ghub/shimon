import type { Page } from "playwright";

import type { JsonValue } from "./canonicalize.ts";
import { ShimonError } from "./errors.ts";
import type { ShimonCase, ShimonConfig } from "./types.ts";

const FREEZE_STYLES = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition: none !important;
  }
`;

type Execute = <T>(promise: Promise<T>) => Promise<T>;

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

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function runConfiguredCase(
  page: Page,
  config: ShimonConfig,
  testCase: ShimonCase,
  execute: Execute = async (promise) => promise,
): Promise<JsonValue> {
  if (config.freezeAnimations) {
    await execute(page.addStyleTag({ content: FREEZE_STYLES }).then(() => undefined));
  }
  await execute(page.evaluate(() => document.fonts.ready));
  if (config.stabilize) {
    await execute(Promise.resolve().then(() => config.stabilize!(page)));
  }
  await execute(settle(page));
  if (testCase.prepare) {
    await execute(Promise.resolve().then(() => testCase.prepare!(page)));
  }
  await execute(settle(page));
  return asJsonValue(
    await execute(Promise.resolve().then(() => config.probe(page))),
    `cases.${testCase.name}.probe`,
  );
}
