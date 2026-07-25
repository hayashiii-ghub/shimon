import type { Page } from "playwright";

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

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function prepareConfiguredCase(
  page: Page,
  config: ShimonConfig,
  testCase: ShimonCase,
  execute: Execute = async (promise) => promise,
): Promise<void> {
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
}
