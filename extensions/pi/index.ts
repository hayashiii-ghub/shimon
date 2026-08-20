/**
 * piへshimonの視覚検証をツールとして接続する。
 * 自動検査と同じ状態のスクリーンショットを、エージェントが1回の呼び出しで確認するために使う。
 */

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright";
import { Type } from "typebox";

import { loadConfig } from "../../src/config.ts";
import { sanitizeDiagnosticText } from "../../src/diagnostics.ts";
import { operationalError, ShimonError } from "../../src/errors.ts";
import type { ShimonCase, ShimonConfig, Viewport } from "../../src/types.ts";
import { verifyProject, type VerifyResult } from "../../src/verify.ts";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

const shimonParameters = Type.Object({
  url: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Absolute URL of an already-running page to verify without project configuration.",
    }),
  ),
  cases: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({
          minLength: 1,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          description: "Stable ASCII identifier for this UI state.",
        }),
        path: Type.Optional(
          Type.String({
            minLength: 1,
            pattern: "^/(?![/\\\\]).*",
            description: "Optional path relative to url, beginning with one slash.",
          }),
        ),
        viewport: Type.Optional(
          Type.Object({
            width: Type.Integer({ minimum: 1 }),
            height: Type.Integer({ minimum: 1 }),
          }),
        ),
        intent: Type.Optional(Type.String({ minLength: 1 })),
        review: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      }),
      {
        minItems: 1,
        maxItems: 5,
        description: "Agent-authored UI states to verify; omit for one default page case.",
      },
    ),
  ),
  mask: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "CSS selectors whose contents must be masked in screenshots.",
    }),
  ),
  caseNames: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Optional configured case names to run; omit to run every case.",
    }),
  ),
  configPath: Type.Optional(
    Type.String({ minLength: 1, description: "Config path relative to the project root." }),
  ),
  taskPath: Type.Optional(
    Type.String({ minLength: 1, description: "Task case module relative to the project root." }),
  ),
});

interface InlineCase {
  name: string;
  path?: string;
  viewport?: Viewport;
  intent?: string;
  review?: string[];
}

interface ShimonParameters {
  url?: string;
  cases?: InlineCase[];
  mask?: string[];
  caseNames?: string[];
  configPath?: string;
  taskPath?: string;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1200, height: 900 };

function inlineEvidenceRoot(cwd: string): string {
  const projectId = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return resolve(tmpdir(), "shimon-pi", projectId);
}

function inlineConfig(params: ShimonParameters): ShimonConfig {
  if (!params.url) {
    throw new ShimonError("config_invalid", "url is required for zero-config verification.");
  }
  if (params.configPath || params.taskPath) {
    throw new ShimonError(
      "config_invalid",
      "url cannot be combined with configPath or taskPath.",
      "Use url and inline cases, or use project configuration, but not both.",
    );
  }
  try {
    new URL(params.url);
  } catch {
    throw new ShimonError("config_invalid", "url must be an absolute URL.");
  }

  const names = new Set<string>();
  const cases: ShimonCase[] = (params.cases ?? [{ name: "page" }]).map((testCase, index) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(testCase.name)) {
      throw new ShimonError(
        "config_invalid",
        `cases[${index}].name must use 1-64 letters, numbers, dots, dashes, or underscores.`,
      );
    }
    if (names.has(testCase.name)) {
      throw new ShimonError("config_invalid", `Duplicate case name: ${testCase.name}`);
    }
    names.add(testCase.name);
    if (
      testCase.path !== undefined &&
      (!testCase.path.startsWith("/") || testCase.path.startsWith("//") || testCase.path.startsWith("/\\"))
    ) {
      throw new ShimonError(
        "config_invalid",
        `cases[${index}].path must be a project-relative path starting with a single "/".`,
      );
    }
    if (
      testCase.viewport !== undefined &&
      (!Number.isInteger(testCase.viewport.width) ||
        testCase.viewport.width <= 0 ||
        !Number.isInteger(testCase.viewport.height) ||
        testCase.viewport.height <= 0)
    ) {
      throw new ShimonError(
        "config_invalid",
        `cases[${index}].viewport width and height must be positive integers.`,
      );
    }
    return testCase;
  });

  return {
    target: { url: params.url, viewport: DEFAULT_VIEWPORT },
    cases,
    freezeAnimations: true,
    screenshot: { mask: params.mask ?? [] },
  };
}

function formatResult(result: VerifyResult): string {
  const automated = result.pass ? "Automated checks passed" : "Automated checks failed";
  const review = result.visualReviewRequired
    ? "Review every attached screenshot against each case's intent and review criteria."
    : "No screenshots require visual review.";
  return `${automated}: ${result.summary.passed}/${result.summary.total} cases passed.\n${review}\n\n${JSON.stringify(result)}`;
}

async function resultContent(result: VerifyResult): Promise<ToolContent[]> {
  const content: ToolContent[] = [{ type: "text", text: formatResult(result) }];
  for (const testCase of result.cases) {
    const screenshot = testCase.evidence.screenshot;
    if (!screenshot) continue;
    content.push({
      type: "image",
      mimeType: "image/png",
      data: (await readFile(screenshot)).toString("base64"),
    });
  }
  return content;
}

function toolError(error: unknown): Error {
  const failure = operationalError(error);
  if (failure.code === "config_not_found") {
    return new Error(
      "Pass url to shimon_verify for zero-config verification, or create shimon.config.mjs for advanced project configuration.",
    );
  }
  const message = sanitizeDiagnosticText(failure.message);
  const hint = failure.hint ? sanitizeDiagnosticText(failure.hint) : undefined;
  return new Error(hint ? `${message}\n${hint}` : message);
}

export function createShimonTool(): ToolDefinition<typeof shimonParameters, VerifyResult> {
  return defineTool({
    name: "shimon_verify",
    label: "shimon verify",
    description:
      "Verify an already-running page from a URL and inline cases, returning automated findings plus screenshots from the same browser state. Project configuration is optional.",
    promptSnippet: "Verify changed UI states with automated checks and screenshots",
    promptGuidelines: [
      "Use shimon_verify after UI, layout, or interaction changes. Normally pass the already-running local URL and 1-5 inline cases; no shimon config file is required.",
      "After shimon_verify, inspect every returned screenshot against its intent and review criteria; pass alone does not complete visual review.",
      "Use trusted project configuration only when the project needs managed server startup, prepare functions, custom checks, or reusable advanced settings.",
    ],
    parameters: shimonParameters,

    async execute(
      _toolCallId: string,
      params: ShimonParameters,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      signal?.throwIfAborted();
      try {
        const config = params.url
          ? inlineConfig(params)
          : (
              await loadConfig({
                cwd: ctx.cwd,
                configPath: params.configPath,
                taskPath: params.taskPath,
              })
            ).config;
        const result = await verifyProject(config, {
          root: params.url ? inlineEvidenceRoot(ctx.cwd) : resolve(ctx.cwd, ".shimon"),
          caseNames: params.caseNames,
          cwd: ctx.cwd,
          configPath: params.configPath,
          taskPath: params.taskPath,
        });
        if (params.url) {
          for (const testCase of result.cases) {
            testCase.reproduce = `Call shimon_verify again with the same url and inline case ${JSON.stringify(testCase.name)}.`;
          }
        }
        signal?.throwIfAborted();
        return { content: await resultContent(result), details: result };
      } catch (error) {
        throw toolError(error);
      }
    },
  });
}

export default function shimonForPi(pi: ExtensionAPI) {
  pi.registerTool(createShimonTool());

  pi.registerCommand("shimon", {
    description: "shimonの実行状態を確認する",
    handler: async (_args, ctx) => {
      try {
        await access(chromium.executablePath());
        ctx.ui.notify(
          "shimonはゼロ設定で利用できます。UI変更後にURLを指定してshimon_verifyを実行してください。",
          "info",
        );
      } catch {
        ctx.ui.notify(
          "Chromiumがありません。npx playwright install chromium を実行してください。",
          "warning",
        );
      }
    },
  });
}
