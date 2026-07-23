import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ShimonError } from "./errors.ts";
import type { LoadedConfig, ProjectCheck, ShimonCase, ShimonConfig, Viewport } from "./types.ts";

const DEFAULT_CONFIG = "shimon.config.mjs";
const DEFAULT_VIEWPORT: Viewport = { width: 1200, height: 900 };
const DEFAULT_TIMEOUTS = { runMs: 120_000, caseMs: 20_000, navigationMs: 10_000 };

function invalid(message: string): never {
  throw new ShimonError("config_invalid", message, "Check shimon.config.mjs.");
}

function validateViewport(value: unknown, path = "target.viewport"): Viewport {
  if (value === undefined) return DEFAULT_VIEWPORT;
  if (value === null || typeof value !== "object") invalid(`${path} must be an object.`);

  const viewport = value as Partial<Viewport>;
  if (!Number.isInteger(viewport.width) || (viewport.width ?? 0) <= 0) {
    invalid(`${path}.width must be a positive integer.`);
  }
  if (!Number.isInteger(viewport.height) || (viewport.height ?? 0) <= 0) {
    invalid(`${path}.height must be a positive integer.`);
  }
  return { width: viewport.width as number, height: viewport.height as number };
}

function validateViewports(value: unknown): Record<string, Viewport> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("viewports must be an object.");
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, viewport]) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        invalid(`viewport name ${JSON.stringify(name)} must use 1-64 letters, numbers, dots, dashes, or underscores.`);
      }
      return [name, validateViewport(viewport, `viewports.${name}`)];
    }),
  );
}

function validateOptionalText(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") invalid(`${path} must be a non-empty string.`);
  return value;
}

function validateReview(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    invalid(`${path} must be an array of non-empty strings.`);
  }
  return value as string[];
}

function validateProjectChecks(value: unknown, caseName: string, path: string): ProjectCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(`${path} must be an array.`);
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object") invalid(`${path}[${index}] must be an object.`);
    const check = candidate as Partial<ProjectCheck>;
    if (typeof check.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(check.id)) {
      invalid(`${path}[${index}].id must use 1-64 letters, numbers, dots, dashes, or underscores.`);
    }
    if (ids.has(check.id)) invalid(`Duplicate check id in case ${caseName}: ${check.id}`);
    ids.add(check.id);
    if (typeof check.description !== "string" || check.description.trim() === "") {
      invalid(`${path}[${index}].description must be a non-empty string.`);
    }
    if (typeof check.evaluate !== "function") invalid(`${path}[${index}].evaluate must be a function.`);
    return check as ProjectCheck;
  });
}

function validateCases(value: unknown, viewports: Record<string, Viewport>): ShimonCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("cases must be an array.");

  const names = new Set<string>();
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object") invalid(`cases[${index}] must be an object.`);
    const item = candidate as Partial<ShimonCase>;
    if (typeof item.name !== "string" || item.name.trim() === "") {
      invalid(`cases[${index}].name must be a non-empty string.`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.name)) {
      invalid(`cases[${index}].name must use 1-64 letters, numbers, dots, dashes, or underscores.`);
    }
    if (names.has(item.name)) invalid(`Duplicate case name: ${item.name}`);
    names.add(item.name);
    if (item.prepare !== undefined && typeof item.prepare !== "function") {
      invalid(`cases[${index}].prepare must be a function.`);
    }
    const rawViewport = (candidate as Record<string, unknown>).viewport;
    let viewport: Viewport | undefined;
    let viewportName: string | undefined;
    if (typeof rawViewport === "string") {
      viewport = viewports[rawViewport];
      if (!viewport) {
        invalid(`cases[${index}].viewport references unknown viewport ${JSON.stringify(rawViewport)}.`);
      }
      viewportName = rawViewport;
    } else if (rawViewport !== undefined) {
      viewport = validateViewport(rawViewport, `cases[${index}].viewport`);
    }
    const path = validateOptionalText((candidate as Record<string, unknown>).path, `cases[${index}].path`);
    if (
      path !== undefined &&
      (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\"))
    ) {
      invalid(`cases[${index}].path must be a project-relative path starting with a single "/".`);
    }
    return {
      name: item.name,
      path,
      viewport,
      viewportName,
      intent: validateOptionalText((candidate as Record<string, unknown>).intent, `cases[${index}].intent`),
      review: validateReview((candidate as Record<string, unknown>).review, `cases[${index}].review`),
      checks: validateProjectChecks(
        (candidate as Record<string, unknown>).checks,
        item.name,
        `cases[${index}].checks`,
      ),
      prepare: item.prepare,
    };
  });
}

function validateScreenshot(value: unknown): ShimonConfig["screenshot"] {
  if (value === undefined) return { mask: [] };
  if (value === null || typeof value !== "object") invalid("screenshot must be an object.");
  const mask = (value as Record<string, unknown>).mask;
  if (mask === undefined) return { mask: [] };
  if (!Array.isArray(mask) || mask.some((selector) => typeof selector !== "string" || selector.trim() === "")) {
    invalid("screenshot.mask must be an array of non-empty selectors.");
  }
  return { mask: mask as string[] };
}

function positiveInteger(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) invalid(`${path} must be a positive integer.`);
  return value as number;
}

function validateTimeouts(value: unknown): NonNullable<ShimonConfig["timeouts"]> {
  if (value === undefined) return DEFAULT_TIMEOUTS;
  if (value === null || typeof value !== "object") invalid("timeouts must be an object.");
  const timeouts = value as Record<string, unknown>;
  return {
    runMs: positiveInteger(timeouts.runMs, DEFAULT_TIMEOUTS.runMs, "timeouts.runMs"),
    caseMs: positiveInteger(timeouts.caseMs, DEFAULT_TIMEOUTS.caseMs, "timeouts.caseMs"),
    navigationMs: positiveInteger(
      timeouts.navigationMs,
      DEFAULT_TIMEOUTS.navigationMs,
      "timeouts.navigationMs",
    ),
  };
}

function validateWebServer(value: unknown): ShimonConfig["webServer"] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") invalid("webServer must be an object.");
  const server = value as Record<string, unknown>;
  if (typeof server.command !== "string" || server.command.trim() === "") {
    invalid("webServer.command must be a non-empty string.");
  }
  if (typeof server.url !== "string") invalid("webServer.url must be a string.");
  try {
    const url = new URL(server.url as string);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    invalid("webServer.url must be an absolute HTTP(S) URL.");
  }
  if (server.reuseExisting !== undefined && typeof server.reuseExisting !== "boolean") {
    invalid("webServer.reuseExisting must be a boolean.");
  }
  return {
    command: server.command as string,
    url: server.url as string,
    reuseExisting: server.reuseExisting !== false,
    timeoutMs: positiveInteger(server.timeoutMs, 30_000, "webServer.timeoutMs"),
  };
}

function validateConfig(value: unknown): ShimonConfig {
  if (value === null || typeof value !== "object") invalid("The default export must be an object.");
  const candidate = value as Record<string, unknown>;
  const target = candidate.target;
  if (target === null || typeof target !== "object") invalid("target must be an object.");
  const targetValue = target as Record<string, unknown>;
  if (typeof targetValue.url !== "string") invalid("target.url must be a string.");
  try {
    new URL(targetValue.url);
  } catch {
    invalid("target.url must be an absolute URL.");
  }
  if (candidate.probe !== undefined && typeof candidate.probe !== "function") {
    invalid("probe must be a function.");
  }
  if (candidate.stabilize !== undefined && typeof candidate.stabilize !== "function") {
    invalid("stabilize must be a function.");
  }
  if (candidate.freezeAnimations !== undefined && typeof candidate.freezeAnimations !== "boolean") {
    invalid("freezeAnimations must be a boolean.");
  }

  const viewports = validateViewports(candidate.viewports);
  return {
    target: {
      url: targetValue.url,
      viewport: validateViewport(targetValue.viewport),
    },
    viewports,
    cases: validateCases(candidate.cases, viewports),
    probe: (candidate.probe ?? (() => ({}))) as ShimonConfig["probe"],
    stabilize: candidate.stabilize as ShimonConfig["stabilize"],
    freezeAnimations: candidate.freezeAnimations !== false,
    screenshot: validateScreenshot(candidate.screenshot),
    webServer: validateWebServer(candidate.webServer),
    timeouts: validateTimeouts(candidate.timeouts),
  };
}

export async function loadConfig(options: {
  cwd: string;
  configPath?: string;
}): Promise<LoadedConfig> {
  const requested = options.configPath ?? DEFAULT_CONFIG;
  const path = isAbsolute(requested) ? requested : resolve(options.cwd, requested);

  try {
    await access(path);
  } catch (error) {
    throw new ShimonError(
      "config_not_found",
      `Config not found: ${path}`,
      "Create shimon.config.mjs or pass --config <path>.",
      { cause: error },
    );
  }

  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    throw new ShimonError("config_load_failed", `Could not load config: ${path}`, undefined, {
      cause: error,
    });
  }

  return { path, config: validateConfig(module.default) };
}
