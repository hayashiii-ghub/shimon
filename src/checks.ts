import { createRequire } from "node:module";

import type { Page, Request, Response } from "playwright";

import { sanitizeDiagnosticText } from "./diagnostics.ts";
import { publicTargetUrl } from "./url.ts";

const MAX_ITEMS = 20;
const require = createRequire(import.meta.url);

export interface PageChecks {
  overflow: {
    pass: boolean;
    amount: number;
    offenders: Array<{
      selector: string;
      box: { x: number; y: number; width: number; height: number; right: number };
      overflowX: number;
    }>;
  };
  consoleErrors: { pass: boolean; messages: string[] };
  failedRequests: {
    pass: boolean;
    requests: Array<{
      url: string;
      method: string;
      resourceType: string;
      status: number | null;
      error: string | null;
    }>;
  };
  a11y: {
    pass: boolean;
    violations: Array<{
      id: string;
      impact: string | null;
      description: string;
      helpUrl: string;
      nodes: number;
      targets: string[];
    }>;
  };
}

export function collectPageFailures(page: Page): {
  snapshot: () => Pick<PageChecks, "consoleErrors" | "failedRequests">;
} {
  const messages: string[] = [];
  const requests: PageChecks["failedRequests"]["requests"] = [];
  const pushRequest = (request: Request, response?: Response): void => {
    if (requests.length >= MAX_ITEMS) return;
    requests.push({
      url: publicTargetUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response?.status() ?? null,
      error: response ? null : sanitizeDiagnosticText(request.failure()?.errorText ?? "failed"),
    });
  };

  page.on("console", (message) => {
    if (message.type() === "error" && messages.length < MAX_ITEMS) {
      messages.push(sanitizeDiagnosticText(message.text()));
    }
  });
  page.on("pageerror", (error) => {
    if (messages.length < MAX_ITEMS) messages.push(sanitizeDiagnosticText(error.message));
  });
  page.on("requestfailed", (request) => pushRequest(request));
  page.on("response", (response) => {
    if (response.status() >= 400) pushRequest(response.request(), response);
  });

  return {
    snapshot: () => ({
      consoleErrors: { pass: messages.length === 0, messages: [...messages] },
      failedRequests: { pass: requests.length === 0, requests: [...requests] },
    }),
  };
}

export async function runPageChecks(
  page: Page,
  failures: ReturnType<typeof collectPageFailures>,
): Promise<PageChecks> {
  const overflow = await page.evaluate((limit) => {
    const documentElement = document.documentElement;
    const amount = Math.max(0, documentElement.scrollWidth - documentElement.clientWidth);
    const offenders: Array<{
      selector: string;
      box: { x: number; y: number; width: number; height: number; right: number };
      overflowX: number;
    }> = [];
    if (amount > 0) {
      for (const node of document.querySelectorAll("body *")) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.right <= documentElement.clientWidth + 1) continue;
        const element = node as HTMLElement;
        const id = element.id ? `#${element.id}` : "";
        const classes = element.classList.length
          ? `.${[...element.classList].slice(0, 3).join(".")}`
          : "";
        offenders.push({
          selector: `${element.tagName.toLowerCase()}${id}${classes}`,
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            right: Math.round(rect.right),
          },
          overflowX: Math.max(0, Math.round(rect.right - documentElement.clientWidth)),
        });
        if (offenders.length >= limit) break;
      }
    }
    return { amount, offenders };
  }, MAX_ITEMS);

  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const axeResult = (await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<unknown> } }).axe;
    return axe.run();
  })) as {
    violations: Array<{
      id: string;
      impact: string | null;
      description: string;
      helpUrl: string;
      nodes: Array<{ target: unknown[] }>;
    }>;
  };
  const violations = axeResult.violations.slice(0, MAX_ITEMS).map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 5).map((node) => node.target.map(String).join(" ")),
  }));

  return {
    overflow: { pass: overflow.amount === 0, ...overflow },
    ...failures.snapshot(),
    a11y: { pass: violations.length === 0, violations },
  };
}
