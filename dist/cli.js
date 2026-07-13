#!/usr/bin/env node

// src/cli.ts
import { resolve as resolve2 } from "node:path";

// src/config.ts
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/errors.ts
class ShimonError extends Error {
  code;
  hint;
  constructor(code, message, hint, options) {
    super(message, options);
    this.code = code;
    this.hint = hint;
    this.name = "ShimonError";
  }
}
function operationalError(error) {
  if (error instanceof ShimonError)
    return error;
  if (error instanceof Error) {
    return new ShimonError("operation_failed", error.message, undefined, { cause: error });
  }
  return new ShimonError("operation_failed", String(error));
}

// src/config.ts
var DEFAULT_CONFIG = "shimon.config.mjs";
var DEFAULT_VIEWPORT = { width: 1200, height: 900 };
function invalid(message) {
  throw new ShimonError("config_invalid", message, "Check shimon.config.mjs.");
}
function validateViewport(value) {
  if (value === undefined)
    return DEFAULT_VIEWPORT;
  if (value === null || typeof value !== "object")
    invalid("target.viewport must be an object.");
  const viewport = value;
  if (!Number.isInteger(viewport.width) || (viewport.width ?? 0) <= 0) {
    invalid("target.viewport.width must be a positive integer.");
  }
  if (!Number.isInteger(viewport.height) || (viewport.height ?? 0) <= 0) {
    invalid("target.viewport.height must be a positive integer.");
  }
  return { width: viewport.width, height: viewport.height };
}
function validateCases(value) {
  if (!Array.isArray(value) || value.length === 0)
    invalid("cases must be a non-empty array.");
  const names = new Set;
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object")
      invalid(`cases[${index}] must be an object.`);
    const item = candidate;
    if (typeof item.name !== "string" || item.name.trim() === "") {
      invalid(`cases[${index}].name must be a non-empty string.`);
    }
    if (names.has(item.name))
      invalid(`Duplicate case name: ${item.name}`);
    names.add(item.name);
    if (item.prepare !== undefined && typeof item.prepare !== "function") {
      invalid(`cases[${index}].prepare must be a function.`);
    }
    return { name: item.name, prepare: item.prepare };
  });
}
function validateConfig(value) {
  if (value === null || typeof value !== "object")
    invalid("The default export must be an object.");
  const candidate = value;
  const target = candidate.target;
  if (target === null || typeof target !== "object")
    invalid("target must be an object.");
  const targetValue = target;
  if (typeof targetValue.url !== "string")
    invalid("target.url must be a string.");
  try {
    new URL(targetValue.url);
  } catch {
    invalid("target.url must be an absolute URL.");
  }
  if (typeof candidate.probe !== "function")
    invalid("probe must be a function.");
  if (candidate.stabilize !== undefined && typeof candidate.stabilize !== "function") {
    invalid("stabilize must be a function.");
  }
  if (candidate.freezeAnimations !== undefined && typeof candidate.freezeAnimations !== "boolean") {
    invalid("freezeAnimations must be a boolean.");
  }
  return {
    target: {
      url: targetValue.url,
      viewport: validateViewport(targetValue.viewport)
    },
    cases: validateCases(candidate.cases),
    probe: candidate.probe,
    stabilize: candidate.stabilize,
    freezeAnimations: candidate.freezeAnimations !== false
  };
}
async function loadConfig(options) {
  const requested = options.configPath ?? DEFAULT_CONFIG;
  const path = isAbsolute(requested) ? requested : resolve(options.cwd, requested);
  try {
    await access(path);
  } catch (error) {
    throw new ShimonError("config_not_found", `Config not found: ${path}`, "Create shimon.config.mjs or pass --config <path>.", { cause: error });
  }
  let module;
  try {
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    throw new ShimonError("config_load_failed", `Could not load config: ${path}`, undefined, {
      cause: error
    });
  }
  return { path, config: validateConfig(module.default) };
}

// src/diff.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function childPath(parent, key) {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}
function visit(before, after, path, changes) {
  if (Object.is(before, after))
    return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0;index < length; index += 1) {
      visit(before[index], after[index], `${path}[${index}]`, changes);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      visit(before[key], after[key], childPath(path, key), changes);
    }
    return;
  }
  changes.push({ path: path || "$", before, after });
}
function diffJson(before, after) {
  const changes = [];
  visit(before, after, "", changes);
  return changes;
}

// src/runner.ts
import { chromium } from "playwright";

// src/url.ts
function publicTargetUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return url.protocol;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// src/version.ts
var TOOL_VERSION = "0.0.1";

// src/runner.ts
var FREEZE_STYLES = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition: none !important;
  }
`;
function asJsonValue(value, path = "probe") {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (Array.isArray(value))
    return value.map((child, index) => asJsonValue(child, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ShimonError("probe_invalid", `${path} must be a plain JSON object.`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, asJsonValue(child, `${path}.${key}`)]));
  }
  throw new ShimonError("probe_invalid", `${path} is not JSON-serializable.`, "Return only objects, arrays, strings, finite numbers, booleans, or null from probe().");
}
async function settle(page) {
  await page.evaluate(() => new Promise((resolve2) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve2()));
  }));
}
async function captureFingerprint(config) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: config.target.viewport });
    const page = await context.newPage();
    const recordedUrl = publicTargetUrl(config.target.url);
    let response;
    try {
      response = await page.goto(config.target.url, { waitUntil: "load" });
    } catch (error) {
      throw new ShimonError("target_navigation_failed", `Could not load target: ${recordedUrl}`, undefined, {
        cause: error
      });
    }
    if (response && !response.ok()) {
      throw new ShimonError("target_http_error", `Target returned HTTP ${response.status()}: ${recordedUrl}`);
    }
    await page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => {
      return;
    });
    if (config.freezeAnimations) {
      await page.addStyleTag({ content: FREEZE_STYLES });
    }
    await page.evaluate(() => document.fonts.ready);
    await config.stabilize?.(page);
    await settle(page);
    const runtime = await page.evaluate(() => ({
      deviceScaleFactor: window.devicePixelRatio,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }));
    const cases = [];
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
        timezone: runtime.timezone
      },
      cases
    };
  } finally {
    await browser.close();
  }
}

// src/store.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/canonicalize.ts
function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}
function canonicalStringify(value) {
  return `${JSON.stringify(sortValue(value))}
`;
}

// src/store.ts
var LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function artifactPath(root, label) {
  if (!LABEL_PATTERN.test(label) || label === "." || label === "..") {
    throw new Error(`Invalid label ${JSON.stringify(label)}; use 1-128 letters, numbers, dots, dashes, or underscores.`);
  }
  return join(root, `${label}.json`);
}
async function writeArtifact(root, label, artifact) {
  const destination = artifactPath(root, label);
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${label}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, canonicalStringify(artifact), { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}
async function readArtifact(root, label) {
  const source = artifactPath(root, label);
  return JSON.parse(await readFile(source, "utf8"));
}

// src/cli.ts
var HELP = `shimon ${TOOL_VERSION}

Usage:
  shimon selftest [--config <path>] [--json]
  shimon capture <label> [--config <path>] [--json]
  shimon diff <before> <after> [--json]
`;
function usage(message) {
  throw new ShimonError("usage_error", message, "Run shimon --help for usage.");
}
function parseCliArgs(argv) {
  const positionals = [];
  let json = false;
  let configPath;
  for (let index = 0;index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--config") {
      configPath = argv[index + 1];
      if (!configPath || configPath.startsWith("--"))
        usage("--config requires a path.");
      index += 1;
    } else if (argument.startsWith("--config=")) {
      configPath = argument.slice("--config=".length);
      if (!configPath)
        usage("--config requires a path.");
    } else if (argument === "--help" || argument === "-h") {
      positionals.push("help");
    } else if (argument === "--version" || argument === "-v") {
      positionals.push("version");
    } else if (argument.startsWith("-")) {
      usage(`Unknown option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  const command = positionals.shift() ?? "help";
  if (!["capture", "diff", "help", "selftest", "version"].includes(command)) {
    usage(`Unknown command: ${command}`);
  }
  const required = command === "capture" ? 1 : command === "diff" ? 2 : 0;
  if (positionals.length !== required) {
    if (command === "capture")
      usage("capture requires one label.");
    if (command === "diff")
      usage("diff requires two labels.");
    usage(`${command} does not accept labels.`);
  }
  return { command, labels: positionals, json, configPath };
}
function emit(value, json, human) {
  process.stdout.write(json ? `${JSON.stringify(value)}
` : `${human}
`);
}
function progress(message) {
  process.stderr.write(`[shimon] ${message}
`);
}
async function run(args, cwd) {
  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(`${TOOL_VERSION}
`);
    return 0;
  }
  const root = resolve2(cwd, ".shimon");
  if (args.command === "diff") {
    const [beforeLabel, afterLabel] = args.labels;
    const before = await readArtifact(root, beforeLabel);
    const after = await readArtifact(root, afterLabel);
    const changes2 = diffJson(before, after);
    const identical = changes2.length === 0;
    emit({ ok: identical, command: "diff", before: beforeLabel, after: afterLabel, changes: changes2 }, args.json, identical ? `${beforeLabel} and ${afterLabel} are identical` : `${beforeLabel} and ${afterLabel} differ at ${changes2.length} path(s)`);
    return identical ? 0 : 1;
  }
  const loaded = await loadConfig({ cwd, configPath: args.configPath });
  if (args.command === "capture") {
    const label = args.labels[0];
    progress(`capturing ${label} from ${publicTargetUrl(loaded.config.target.url)}`);
    const artifact = await captureFingerprint(loaded.config);
    const path = await writeArtifact(root, label, artifact);
    emit({ ok: true, command: "capture", label, path, cases: artifact.cases.length }, args.json, `captured ${label} -> ${path}`);
    return 0;
  }
  progress(`capturing two fresh runs from ${publicTargetUrl(loaded.config.target.url)}`);
  const first = await captureFingerprint(loaded.config);
  const second = await captureFingerprint(loaded.config);
  const changes = diffJson(first, second);
  const stable = changes.length === 0;
  emit({ ok: stable, command: "selftest", changes }, args.json, stable ? "selftest passed: two fresh captures are identical" : `selftest failed at ${changes.length} path(s)`);
  return stable ? 0 : 1;
}
async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let json = argv.includes("--json");
  try {
    const args = parseCliArgs(argv);
    json = args.json;
    return await run(args, cwd);
  } catch (error) {
    const failure = operationalError(error);
    const payload = {
      ok: false,
      error: { code: failure.code, message: failure.message, ...failure.hint ? { hint: failure.hint } : {} }
    };
    process.stderr.write(json ? `${JSON.stringify(payload)}
` : `shimon: ${failure.message}
`);
    return 2;
  }
}

// src/bin.ts
process.exitCode = await main();
