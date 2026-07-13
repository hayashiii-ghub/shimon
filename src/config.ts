import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ShimonError } from "./errors.ts";
import type { LoadedConfig, ShimonCase, ShimonConfig, Viewport } from "./types.ts";

const DEFAULT_CONFIG = "shimon.config.mjs";
const DEFAULT_VIEWPORT: Viewport = { width: 1200, height: 900 };

function invalid(message: string): never {
  throw new ShimonError("config_invalid", message, "Check shimon.config.mjs.");
}

function validateViewport(value: unknown): Viewport {
  if (value === undefined) return DEFAULT_VIEWPORT;
  if (value === null || typeof value !== "object") invalid("target.viewport must be an object.");

  const viewport = value as Partial<Viewport>;
  if (!Number.isInteger(viewport.width) || (viewport.width ?? 0) <= 0) {
    invalid("target.viewport.width must be a positive integer.");
  }
  if (!Number.isInteger(viewport.height) || (viewport.height ?? 0) <= 0) {
    invalid("target.viewport.height must be a positive integer.");
  }
  return { width: viewport.width as number, height: viewport.height as number };
}

function validateCases(value: unknown): ShimonCase[] {
  if (!Array.isArray(value) || value.length === 0) invalid("cases must be a non-empty array.");

  const names = new Set<string>();
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object") invalid(`cases[${index}] must be an object.`);
    const item = candidate as Partial<ShimonCase>;
    if (typeof item.name !== "string" || item.name.trim() === "") {
      invalid(`cases[${index}].name must be a non-empty string.`);
    }
    if (names.has(item.name)) invalid(`Duplicate case name: ${item.name}`);
    names.add(item.name);
    if (item.prepare !== undefined && typeof item.prepare !== "function") {
      invalid(`cases[${index}].prepare must be a function.`);
    }
    return { name: item.name, prepare: item.prepare };
  });
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
  if (typeof candidate.probe !== "function") invalid("probe must be a function.");
  if (candidate.stabilize !== undefined && typeof candidate.stabilize !== "function") {
    invalid("stabilize must be a function.");
  }
  if (candidate.freezeAnimations !== undefined && typeof candidate.freezeAnimations !== "boolean") {
    invalid("freezeAnimations must be a boolean.");
  }

  return {
    target: {
      url: targetValue.url,
      viewport: validateViewport(targetValue.viewport),
    },
    cases: validateCases(candidate.cases),
    probe: candidate.probe as ShimonConfig["probe"],
    stabilize: candidate.stabilize as ShimonConfig["stabilize"],
    freezeAnimations: candidate.freezeAnimations !== false,
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
