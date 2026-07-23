import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { runConfiguredCase } from "./case-runner.ts";
import { collectPageFailures, runPageChecks, type PageChecks } from "./checks.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import { operationalError, ShimonError } from "./errors.ts";
import { pruneRunDirectories, writeJsonAtomic } from "./evidence.ts";
import type { JsonValue } from "./canonicalize.ts";
import { runProjectChecks } from "./project-checks.ts";
import type { ProjectCheckResult, ShimonConfig, Viewport } from "./types.ts";
import { publicTargetUrl } from "./url.ts";
import { startManagedWebServer } from "./web-server.ts";

export interface VerifyCaseResult {
  name: string;
  url: string;
  status: "completed" | "failed";
  pass: boolean;
  viewport: Viewport;
  viewportName: string | null;
  intent: string | null;
  review: string[];
  probe: JsonValue | null;
  checks: (PageChecks & { project: ProjectCheckResult[] }) | null;
  evidence: { screenshot: string | null };
  reproduce: string;
  error?: { code: string; message: string; hint?: string };
}

export interface VerifyResult {
  schemaVersion: 1;
  success: true;
  pass: boolean;
  command: "verify";
  run: {
    id: string;
    createdAt: string;
    configDigest: string;
    durationMs: number;
    webServer: { managed: boolean; reused: boolean };
  };
  cases: VerifyCaseResult[];
  summary: { total: number; passed: number; failed: number };
  manifest: string;
}

function configDigest(config: ShimonConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: { url: publicTargetUrl(config.target.url), viewport: config.target.viewport },
        cases: config.cases.map((testCase) => ({
          name: testCase.name,
          path: testCase.path,
          viewport: testCase.viewport,
          viewportName: testCase.viewportName,
          intent: testCase.intent,
          review: testCase.review,
          checks: testCase.checks?.map(({ id, description }) => ({ id, description })),
        })),
        freezeAnimations: config.freezeAnimations,
        screenshot: config.screenshot,
        timeouts: config.timeouts,
        webServer: config.webServer,
      }),
    )
    .digest("hex");
}

function caseFilename(index: number, name: string): string {
  const slug = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "case";
  return `${String(index + 1).padStart(2, "0")}-${slug}.png`;
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  code: "case_timeout" | "run_timeout",
  message: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ShimonError(code, message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ShimonError(code, message)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyProject(
  config: ShimonConfig,
  options: { root: string; caseNames?: string[]; cwd?: string; configPath?: string },
): Promise<VerifyResult> {
  if (config.cases.length === 0) {
    throw new ShimonError(
      "cases_required",
      "No verification cases are configured.",
      "Create an agent-authored task config with at least one case and pass --config <path>.",
    );
  }
  const startedAt = Date.now();
  const runDeadline = startedAt + (config.timeouts?.runMs ?? 120_000);
  const requestedCases = options.caseNames ?? [];
  const knownCases = new Set(config.cases.map((testCase) => testCase.name));
  const unknownCase = requestedCases.find((name) => !knownCases.has(name));
  if (unknownCase) {
    throw new ShimonError(
      "case_not_found",
      `Unknown case: ${unknownCase}`,
      `Available cases: ${config.cases.map((testCase) => testCase.name).join(", ")}`,
    );
  }
  const runId = randomUUID();
  const root = resolve(options.root);
  const runDirectory = join(root, "runs", runId);
  const screenshotDirectory = join(runDirectory, "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  const selected = requestedCases.length
    ? config.cases.filter((testCase) => requestedCases.includes(testCase.name))
    : config.cases;
  let webServer: Awaited<ReturnType<typeof startManagedWebServer>> | undefined;
  if (config.webServer) {
    const remaining = runDeadline - Date.now();
    if (remaining <= 0) {
      throw new ShimonError("run_timeout", "Verification run timed out before starting the web server.");
    }
    const serverWasRunBound = remaining < config.webServer.timeoutMs;
    try {
      webServer = await startManagedWebServer({
        ...config.webServer,
        timeoutMs: Math.min(config.webServer.timeoutMs, remaining),
        cwd: options.cwd ?? process.cwd(),
      });
    } catch (error) {
      const failure = operationalError(error);
      if (serverWasRunBound && failure.code === "web_server_timeout") {
        throw new ShimonError("run_timeout", "Verification run timed out while starting the web server.");
      }
      throw error;
    }
  }
  const cases: VerifyCaseResult[] = [];
  const reproduce = (caseName: string): string =>
    `shimon verify --case ${caseName}${
      options.configPath ? ` --config ${JSON.stringify(options.configPath)}` : ""
    } --json`;

  try {
    const browser = await beforeDeadline(
      chromium.launch({ headless: true }),
      runDeadline,
      "run_timeout",
      "Verification run timed out while launching Chromium.",
    );
    try {
      for (const [caseIndex, testCase] of selected.entries()) {
        const caseBudgetDeadline = Date.now() + (config.timeouts?.caseMs ?? 20_000);
        const caseDeadline = Math.min(caseBudgetDeadline, runDeadline);
        const deadlineCode = runDeadline <= caseBudgetDeadline ? "run_timeout" : "case_timeout";
        const withinCase = <T>(promise: Promise<T>): Promise<T> =>
          beforeDeadline(
            promise,
            caseDeadline,
            deadlineCode,
            deadlineCode === "run_timeout"
              ? `Verification run timed out during case: ${testCase.name}`
              : `Case timed out: ${testCase.name}`,
          );
        const viewport = testCase.viewport ?? config.target.viewport;
        const caseUrl =
          testCase.path === undefined
            ? config.target.url
            : new URL(testCase.path, config.target.url).toString();
        const recordedCaseUrl = publicTargetUrl(caseUrl);
        const context = await beforeDeadline(
          browser.newContext({ viewport }),
          runDeadline,
          "run_timeout",
          `Verification run timed out while creating context for case: ${testCase.name}`,
        );
        const screenshot = join(screenshotDirectory, caseFilename(caseIndex, testCase.name));
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(config.timeouts?.caseMs ?? 20_000);
          try {
            const failures = collectPageFailures(page);
            await withinCase(
              page.goto(caseUrl, {
                waitUntil: "load",
                timeout: Math.min(
                  config.timeouts?.navigationMs ?? 10_000,
                  Math.max(1, caseDeadline - Date.now()),
                ),
              }),
            );
            await withinCase(
              page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined),
            );
            const probe = await runConfiguredCase(page, config, testCase, withinCase);
            await withinCase(
              page.screenshot({
                path: screenshot,
                fullPage: false,
                mask: (config.screenshot?.mask ?? []).map((selector) => page.locator(selector)),
                maskColor: "#000000",
              }),
            );
            const builtInChecks = await withinCase(runPageChecks(page, failures));
            const project = await runProjectChecks(page, testCase.checks, withinCase);
            const checks = { ...builtInChecks, project };
            const pass =
              Object.values(builtInChecks).every((check) => check.pass) &&
              project.every((check) => check.pass);
            cases.push({
              name: testCase.name,
              url: recordedCaseUrl,
              status: "completed",
              pass,
              viewport,
              viewportName: testCase.viewportName ?? null,
              intent: testCase.intent ?? null,
              review: testCase.review ?? [],
              probe,
              checks,
              evidence: { screenshot },
              reproduce: reproduce(testCase.name),
            });
          } catch (error) {
            const failure = operationalError(error);
            if (failure.code === "run_timeout") throw failure;
            const evidence = await page
              .screenshot({
                path: screenshot,
                fullPage: false,
                mask: (config.screenshot?.mask ?? []).map((selector) => page.locator(selector)),
                maskColor: "#000000",
                timeout: Math.min(config.timeouts?.caseMs ?? 20_000, 2_000),
              })
              .then(() => screenshot)
              .catch(() => null);
            cases.push({
              name: testCase.name,
              url: recordedCaseUrl,
              status: "failed",
              pass: false,
              viewport,
              viewportName: testCase.viewportName ?? null,
              intent: testCase.intent ?? null,
              review: testCase.review ?? [],
              probe: null,
              checks: null,
              evidence: { screenshot: evidence },
              reproduce: reproduce(testCase.name),
              error: {
                code: failure.code === "operation_failed" ? "case_execution_failed" : failure.code,
                message: sanitizeDiagnosticText(failure.message),
                ...(failure.hint ? { hint: sanitizeDiagnosticText(failure.hint) } : {}),
              },
            });
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await webServer?.close();
  }

  const passed = cases.filter((testCase) => testCase.pass).length;
  const manifest = join(runDirectory, "manifest.json");
  const result: VerifyResult = {
    schemaVersion: 1,
    success: true,
    pass: passed === cases.length,
    command: "verify",
    run: {
      id: runId,
      createdAt: new Date(startedAt).toISOString(),
      configDigest: configDigest(config),
      durationMs: Date.now() - startedAt,
      webServer: { managed: webServer !== undefined, reused: webServer?.reused ?? false },
    },
    cases,
    summary: { total: cases.length, passed, failed: cases.length - passed },
    manifest,
  };
  await writeJsonAtomic(manifest, result);
  await writeJsonAtomic(join(root, "latest.json"), { runId, manifest });
  await pruneRunDirectories(root, 3);
  return result;
}
