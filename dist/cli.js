#!/usr/bin/env node

// src/cli.ts
import { resolve as resolve3 } from "node:path";

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
var DEFAULT_TIMEOUTS = { runMs: 120000, caseMs: 20000, navigationMs: 1e4 };
function invalid(message) {
  throw new ShimonError("config_invalid", message, "Check shimon.config.mjs.");
}
function validateViewport(value, path = "target.viewport") {
  if (value === undefined)
    return DEFAULT_VIEWPORT;
  if (value === null || typeof value !== "object")
    invalid(`${path} must be an object.`);
  const viewport = value;
  if (!Number.isInteger(viewport.width) || (viewport.width ?? 0) <= 0) {
    invalid(`${path}.width must be a positive integer.`);
  }
  if (!Number.isInteger(viewport.height) || (viewport.height ?? 0) <= 0) {
    invalid(`${path}.height must be a positive integer.`);
  }
  return { width: viewport.width, height: viewport.height };
}
function validateViewports(value) {
  if (value === undefined)
    return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("viewports must be an object.");
  }
  return Object.fromEntries(Object.entries(value).map(([name, viewport]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      invalid(`viewport name ${JSON.stringify(name)} must use 1-64 letters, numbers, dots, dashes, or underscores.`);
    }
    return [name, validateViewport(viewport, `viewports.${name}`)];
  }));
}
function validateOptionalText(value, path) {
  if (value === undefined)
    return;
  if (typeof value !== "string" || value.trim() === "")
    invalid(`${path} must be a non-empty string.`);
  return value;
}
function validateReview(value, path) {
  if (value === undefined)
    return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    invalid(`${path} must be an array of non-empty strings.`);
  }
  return value;
}
function validateProjectChecks(value, caseName, path) {
  if (value === undefined)
    return;
  if (!Array.isArray(value))
    invalid(`${path} must be an array.`);
  const ids = new Set;
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object")
      invalid(`${path}[${index}] must be an object.`);
    const check = candidate;
    if (typeof check.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(check.id)) {
      invalid(`${path}[${index}].id must use 1-64 letters, numbers, dots, dashes, or underscores.`);
    }
    if (ids.has(check.id))
      invalid(`Duplicate check id in case ${caseName}: ${check.id}`);
    ids.add(check.id);
    if (typeof check.description !== "string" || check.description.trim() === "") {
      invalid(`${path}[${index}].description must be a non-empty string.`);
    }
    if (typeof check.evaluate !== "function")
      invalid(`${path}[${index}].evaluate must be a function.`);
    return check;
  });
}
function validateCases(value, viewports) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value))
    invalid("cases must be an array.");
  const names = new Set;
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object")
      invalid(`cases[${index}] must be an object.`);
    const item = candidate;
    if (typeof item.name !== "string" || item.name.trim() === "") {
      invalid(`cases[${index}].name must be a non-empty string.`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.name)) {
      invalid(`cases[${index}].name must use 1-64 letters, numbers, dots, dashes, or underscores.`);
    }
    if (names.has(item.name))
      invalid(`Duplicate case name: ${item.name}`);
    names.add(item.name);
    if (item.prepare !== undefined && typeof item.prepare !== "function") {
      invalid(`cases[${index}].prepare must be a function.`);
    }
    const rawViewport = candidate.viewport;
    let viewport;
    let viewportName;
    if (typeof rawViewport === "string") {
      viewport = viewports[rawViewport];
      if (!viewport) {
        invalid(`cases[${index}].viewport references unknown viewport ${JSON.stringify(rawViewport)}.`);
      }
      viewportName = rawViewport;
    } else if (rawViewport !== undefined) {
      viewport = validateViewport(rawViewport, `cases[${index}].viewport`);
    }
    const path = validateOptionalText(candidate.path, `cases[${index}].path`);
    if (path !== undefined && (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\"))) {
      invalid(`cases[${index}].path must be a project-relative path starting with a single "/".`);
    }
    return {
      name: item.name,
      path,
      viewport,
      viewportName,
      intent: validateOptionalText(candidate.intent, `cases[${index}].intent`),
      review: validateReview(candidate.review, `cases[${index}].review`),
      checks: validateProjectChecks(candidate.checks, item.name, `cases[${index}].checks`),
      prepare: item.prepare
    };
  });
}
function validateScreenshot(value) {
  if (value === undefined)
    return { mask: [] };
  if (value === null || typeof value !== "object")
    invalid("screenshot must be an object.");
  const mask = value.mask;
  if (mask === undefined)
    return { mask: [] };
  if (!Array.isArray(mask) || mask.some((selector) => typeof selector !== "string" || selector.trim() === "")) {
    invalid("screenshot.mask must be an array of non-empty selectors.");
  }
  return { mask };
}
function positiveInteger(value, fallback, path) {
  if (value === undefined)
    return fallback;
  if (!Number.isInteger(value) || value <= 0)
    invalid(`${path} must be a positive integer.`);
  return value;
}
function validateTimeouts(value) {
  if (value === undefined)
    return DEFAULT_TIMEOUTS;
  if (value === null || typeof value !== "object")
    invalid("timeouts must be an object.");
  const timeouts = value;
  return {
    runMs: positiveInteger(timeouts.runMs, DEFAULT_TIMEOUTS.runMs, "timeouts.runMs"),
    caseMs: positiveInteger(timeouts.caseMs, DEFAULT_TIMEOUTS.caseMs, "timeouts.caseMs"),
    navigationMs: positiveInteger(timeouts.navigationMs, DEFAULT_TIMEOUTS.navigationMs, "timeouts.navigationMs")
  };
}
function validateWebServer(value) {
  if (value === undefined)
    return;
  if (value === null || typeof value !== "object")
    invalid("webServer must be an object.");
  const server = value;
  if (typeof server.command !== "string" || server.command.trim() === "") {
    invalid("webServer.command must be a non-empty string.");
  }
  if (typeof server.url !== "string")
    invalid("webServer.url must be a string.");
  try {
    const url = new URL(server.url);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("unsupported protocol");
  } catch {
    invalid("webServer.url must be an absolute HTTP(S) URL.");
  }
  if (server.reuseExisting !== undefined && typeof server.reuseExisting !== "boolean") {
    invalid("webServer.reuseExisting must be a boolean.");
  }
  return {
    command: server.command,
    url: server.url,
    reuseExisting: server.reuseExisting !== false,
    timeoutMs: positiveInteger(server.timeoutMs, 30000, "webServer.timeoutMs")
  };
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
      viewport: validateViewport(targetValue.viewport)
    },
    viewports,
    cases: validateCases(candidate.cases, viewports),
    probe: candidate.probe ?? (() => ({})),
    stabilize: candidate.stabilize,
    freezeAnimations: candidate.freezeAnimations !== false,
    screenshot: validateScreenshot(candidate.screenshot),
    webServer: validateWebServer(candidate.webServer),
    timeouts: validateTimeouts(candidate.timeouts)
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

// src/diagnostics.ts
var MAX_DIAGNOSTIC_LENGTH = 500;
var HTTP_URL = /\bhttps?:\/\/[^\s<>"']+/giu;
var SECRET_FIELD = /\b(authorization|password|passwd|secret|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|cookie|set-cookie)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu;
function redactUrl(match) {
  const trailing = match.match(/[),.;!?]+$/u)?.[0] ?? "";
  const candidate = trailing ? match.slice(0, -trailing.length) : match;
  try {
    return `${publicTargetUrl(candidate)}${trailing}`;
  } catch {
    return `[redacted-url]${trailing}`;
  }
}
function sanitizeDiagnosticText(value) {
  const sanitized = value.replace(HTTP_URL, redactUrl).replace(SECRET_FIELD, (_match, field) => `${field}=[redacted]`);
  if (sanitized.length <= MAX_DIAGNOSTIC_LENGTH)
    return sanitized;
  return `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

// src/runner.ts
import { chromium } from "playwright";

// src/case-runner.ts
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
async function runConfiguredCase(page, config, testCase, execute = async (promise) => promise) {
  if (config.freezeAnimations) {
    await execute(page.addStyleTag({ content: FREEZE_STYLES }).then(() => {
      return;
    }));
  }
  await execute(page.evaluate(() => document.fonts.ready));
  if (config.stabilize) {
    await execute(Promise.resolve().then(() => config.stabilize(page)));
  }
  await execute(settle(page));
  if (testCase.prepare) {
    await execute(Promise.resolve().then(() => testCase.prepare(page)));
  }
  await execute(settle(page));
  return asJsonValue(await execute(Promise.resolve().then(() => config.probe(page))), `cases.${testCase.name}.probe`);
}

// src/version.ts
var TOOL_VERSION = "0.1.0";

// src/runner.ts
async function captureFingerprint(config) {
  if (config.cases.length === 0) {
    throw new ShimonError("cases_required", "No verification cases are configured.", "Create an agent-authored task config with at least one case and pass --config <path>.");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const recordedUrl = publicTargetUrl(config.target.url);
    const cases = [];
    let runtime;
    for (const testCase of config.cases) {
      const viewport = testCase.viewport ?? config.target.viewport;
      const caseUrl = testCase.path === undefined ? config.target.url : new URL(testCase.path, config.target.url).toString();
      const recordedCaseUrl = publicTargetUrl(caseUrl);
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        let response;
        try {
          response = await page.goto(caseUrl, { waitUntil: "load" });
        } catch (error) {
          throw new ShimonError("target_navigation_failed", `Could not load target: ${recordedCaseUrl}`, undefined, { cause: error });
        }
        if (response && !response.ok()) {
          throw new ShimonError("target_http_error", `Target returned HTTP ${response.status()}: ${recordedCaseUrl}`);
        }
        await page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => {
          return;
        });
        runtime ??= await page.evaluate(() => ({
          deviceScaleFactor: window.devicePixelRatio,
          locale: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }));
        const probe = await runConfiguredCase(page, config, testCase);
        cases.push({ name: testCase.name, url: recordedCaseUrl, viewport, probe });
      } finally {
        await context.close();
      }
    }
    if (!runtime)
      throw new ShimonError("cases_required", "No verification cases are configured.");
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
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isViewport(value) {
  if (!isRecord2(value))
    return false;
  return Number.isInteger(value.width) && value.width > 0 && Number.isInteger(value.height) && value.height > 0;
}
function isFingerprintArtifact(value) {
  if (!isRecord2(value.target) || typeof value.target.url !== "string")
    return false;
  if (!isRecord2(value.environment))
    return false;
  const environment = value.environment;
  if (typeof environment.browser !== "string" || typeof environment.browserVersion !== "string" || !isViewport(environment.viewport) || typeof environment.deviceScaleFactor !== "number" || !Number.isFinite(environment.deviceScaleFactor) || typeof environment.locale !== "string" || typeof environment.timezone !== "string") {
    return false;
  }
  if (!Array.isArray(value.cases))
    return false;
  return value.cases.every((testCase) => isRecord2(testCase) && typeof testCase.name === "string" && isViewport(testCase.viewport) && Object.hasOwn(testCase, "probe"));
}
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
  let artifact;
  try {
    artifact = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new ShimonError("artifact_invalid", `Could not read artifact: ${source}`, undefined, {
      cause: error
    });
  }
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new ShimonError("artifact_invalid", `Artifact must be a JSON object: ${source}`);
  }
  const value = artifact;
  if (value.schemaVersion !== 2) {
    throw new ShimonError("artifact_incompatible", `Artifact schema ${String(value.schemaVersion)} is not supported: ${source}`, "Capture a fresh artifact with this shimon version.");
  }
  if (typeof value.toolVersion !== "string" || !isFingerprintArtifact(value)) {
    throw new ShimonError("artifact_invalid", `Artifact is missing required fields: ${source}`);
  }
  return artifact;
}

// src/verify.ts
import { createHash, randomUUID as randomUUID3 } from "node:crypto";
import { mkdir as mkdir2 } from "node:fs/promises";
import { join as join3, resolve as resolve2 } from "node:path";
import { chromium as chromium2 } from "playwright";

// src/checks.ts
import { createRequire } from "node:module";
var MAX_ITEMS = 20;
var require2 = createRequire(import.meta.url);
function collectPageFailures(page) {
  const messages = [];
  const requests = [];
  const pushRequest = (request, response) => {
    if (requests.length >= MAX_ITEMS)
      return;
    requests.push({
      url: publicTargetUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response?.status() ?? null,
      error: response ? null : sanitizeDiagnosticText(request.failure()?.errorText ?? "failed")
    });
  };
  page.on("console", (message) => {
    if (message.type() === "error" && messages.length < MAX_ITEMS) {
      messages.push(sanitizeDiagnosticText(message.text()));
    }
  });
  page.on("pageerror", (error) => {
    if (messages.length < MAX_ITEMS)
      messages.push(sanitizeDiagnosticText(error.message));
  });
  page.on("requestfailed", (request) => pushRequest(request));
  page.on("response", (response) => {
    if (response.status() >= 400)
      pushRequest(response.request(), response);
  });
  return {
    snapshot: () => ({
      consoleErrors: { pass: messages.length === 0, messages: [...messages] },
      failedRequests: { pass: requests.length === 0, requests: [...requests] }
    })
  };
}
async function runPageChecks(page, failures) {
  const overflow = await page.evaluate((limit) => {
    const documentElement = document.documentElement;
    const amount = Math.max(0, documentElement.scrollWidth - documentElement.clientWidth);
    const offenders = [];
    if (amount > 0) {
      for (const node of document.querySelectorAll("body *")) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.right <= documentElement.clientWidth + 1)
          continue;
        const element = node;
        const id = element.id ? `#${element.id}` : "";
        const classes = element.classList.length ? `.${[...element.classList].slice(0, 3).join(".")}` : "";
        offenders.push({
          selector: `${element.tagName.toLowerCase()}${id}${classes}`,
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            right: Math.round(rect.right)
          },
          overflowX: Math.max(0, Math.round(rect.right - documentElement.clientWidth))
        });
        if (offenders.length >= limit)
          break;
      }
    }
    return { amount, offenders };
  }, MAX_ITEMS);
  await page.addScriptTag({ path: require2.resolve("axe-core/axe.min.js") });
  const axeResult = await page.evaluate(async () => {
    const axe = window.axe;
    return axe.run();
  });
  const violations = axeResult.violations.slice(0, MAX_ITEMS).map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 5).map((node) => node.target.map(String).join(" "))
  }));
  return {
    overflow: { pass: overflow.amount === 0, ...overflow },
    ...failures.snapshot(),
    a11y: { pass: violations.length === 0, violations }
  };
}

// src/evidence.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { readdir, rename as rename2, rm as rm2, stat, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID2()}.tmp`;
  try {
    await writeFile2(temporary, `${JSON.stringify(value)}
`, { encoding: "utf8", flag: "wx" });
    await rename2(temporary, path);
  } finally {
    await rm2(temporary, { force: true });
  }
}
async function pruneRunDirectories(root, keep) {
  const runs = join2(root, "runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join2(runs, entry.name);
    return { path, mtimeMs: (await stat(path)).mtimeMs };
  }));
  directories.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  const removed = directories.slice(0, Math.max(0, directories.length - keep)).map((entry) => entry.path);
  await Promise.all(removed.map((path) => rm2(path, { recursive: true, force: true })));
  return removed;
}

// src/project-checks.ts
async function runProjectChecks(page, checks = [], execute = async (promise) => promise) {
  const results = [];
  for (const check of checks) {
    const value = await execute(Promise.resolve().then(() => check.evaluate(page)));
    if (typeof value === "boolean") {
      results.push({ id: check.id, description: check.description, pass: value });
      continue;
    }
    if (value === null || typeof value !== "object" || typeof value.pass !== "boolean") {
      throw new ShimonError("check_invalid", `Check ${check.id} must return a boolean or { pass, evidence? }.`);
    }
    results.push({
      id: check.id,
      description: check.description,
      pass: value.pass,
      ...value.evidence === undefined ? {} : { evidence: asJsonValue(value.evidence, `checks.${check.id}.evidence`) }
    });
  }
  return results;
}

// src/web-server.ts
import { spawn } from "node:child_process";
async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}
function delay(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve2) => {
    const timer = setTimeout(() => resolve2(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve2(true);
    });
  });
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, "SIGTERM");
    else
      child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 1000))
    return;
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, "SIGKILL");
    else
      child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 1000);
}
async function startManagedWebServer(options) {
  if (await reachable(options.url)) {
    if (!options.reuseExisting) {
      throw new ShimonError("web_server_already_running", `A server is already reachable at ${publicTargetUrl(options.url)}`);
    }
    return { reused: true, close: async () => {
      return;
    } };
  }
  const child = spawn(options.command, {
    cwd: options.cwd,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"]
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      await terminate(child);
      throw new ShimonError("web_server_start_failed", "Could not start the configured web server.", undefined, {
        cause: spawnError
      });
    }
    if (await reachable(options.url)) {
      return { reused: false, close: () => terminate(child) };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new ShimonError("web_server_exited", "The configured web server exited before it was ready.");
    }
    await delay(100);
  }
  await terminate(child);
  throw new ShimonError("web_server_timeout", `Web server did not become ready at ${publicTargetUrl(options.url)} within ${options.timeoutMs}ms.`);
}

// src/verify.ts
function configDigest(config) {
  return createHash("sha256").update(JSON.stringify({
    target: { url: publicTargetUrl(config.target.url), viewport: config.target.viewport },
    cases: config.cases.map((testCase) => ({
      name: testCase.name,
      path: testCase.path,
      viewport: testCase.viewport,
      viewportName: testCase.viewportName,
      intent: testCase.intent,
      review: testCase.review,
      checks: testCase.checks?.map(({ id, description }) => ({ id, description }))
    })),
    freezeAnimations: config.freezeAnimations,
    screenshot: config.screenshot,
    timeouts: config.timeouts,
    webServer: config.webServer
  })).digest("hex");
}
function caseFilename(index, name) {
  const slug = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "case";
  return `${String(index + 1).padStart(2, "0")}-${slug}.png`;
}
async function beforeDeadline(promise, deadline, code, message) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new ShimonError(code, message);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ShimonError(code, message)), remaining);
      })
    ]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
async function verifyProject(config, options) {
  if (config.cases.length === 0) {
    throw new ShimonError("cases_required", "No verification cases are configured.", "Create an agent-authored task config with at least one case and pass --config <path>.");
  }
  const startedAt = Date.now();
  const runDeadline = startedAt + (config.timeouts?.runMs ?? 120000);
  const requestedCases = options.caseNames ?? [];
  const knownCases = new Set(config.cases.map((testCase) => testCase.name));
  const unknownCase = requestedCases.find((name) => !knownCases.has(name));
  if (unknownCase) {
    throw new ShimonError("case_not_found", `Unknown case: ${unknownCase}`, `Available cases: ${config.cases.map((testCase) => testCase.name).join(", ")}`);
  }
  const runId = randomUUID3();
  const root = resolve2(options.root);
  const runDirectory = join3(root, "runs", runId);
  const screenshotDirectory = join3(runDirectory, "screenshots");
  await mkdir2(screenshotDirectory, { recursive: true });
  const selected = requestedCases.length ? config.cases.filter((testCase) => requestedCases.includes(testCase.name)) : config.cases;
  let webServer;
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
        cwd: options.cwd ?? process.cwd()
      });
    } catch (error) {
      const failure = operationalError(error);
      if (serverWasRunBound && failure.code === "web_server_timeout") {
        throw new ShimonError("run_timeout", "Verification run timed out while starting the web server.");
      }
      throw error;
    }
  }
  const cases = [];
  const reproduce = (caseName) => `shimon verify --case ${caseName}${options.configPath ? ` --config ${JSON.stringify(options.configPath)}` : ""} --json`;
  try {
    const browser = await beforeDeadline(chromium2.launch({ headless: true }), runDeadline, "run_timeout", "Verification run timed out while launching Chromium.");
    try {
      for (const [caseIndex, testCase] of selected.entries()) {
        const caseBudgetDeadline = Date.now() + (config.timeouts?.caseMs ?? 20000);
        const caseDeadline = Math.min(caseBudgetDeadline, runDeadline);
        const deadlineCode = runDeadline <= caseBudgetDeadline ? "run_timeout" : "case_timeout";
        const withinCase = (promise) => beforeDeadline(promise, caseDeadline, deadlineCode, deadlineCode === "run_timeout" ? `Verification run timed out during case: ${testCase.name}` : `Case timed out: ${testCase.name}`);
        const viewport = testCase.viewport ?? config.target.viewport;
        const caseUrl = testCase.path === undefined ? config.target.url : new URL(testCase.path, config.target.url).toString();
        const recordedCaseUrl = publicTargetUrl(caseUrl);
        const context = await beforeDeadline(browser.newContext({ viewport }), runDeadline, "run_timeout", `Verification run timed out while creating context for case: ${testCase.name}`);
        const screenshot = join3(screenshotDirectory, caseFilename(caseIndex, testCase.name));
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(config.timeouts?.caseMs ?? 20000);
          try {
            const failures = collectPageFailures(page);
            await withinCase(page.goto(caseUrl, {
              waitUntil: "load",
              timeout: config.timeouts?.navigationMs ?? 1e4
            }));
            await withinCase(page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => {
              return;
            }));
            const probe = await runConfiguredCase(page, config, testCase, withinCase);
            await withinCase(page.screenshot({
              path: screenshot,
              fullPage: false,
              mask: (config.screenshot?.mask ?? []).map((selector) => page.locator(selector)),
              maskColor: "#000000"
            }));
            const builtInChecks = await withinCase(runPageChecks(page, failures));
            const project = await runProjectChecks(page, testCase.checks, withinCase);
            const checks = { ...builtInChecks, project };
            const pass = Object.values(builtInChecks).every((check) => check.pass) && project.every((check) => check.pass);
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
              reproduce: reproduce(testCase.name)
            });
          } catch (error) {
            const failure = operationalError(error);
            if (failure.code === "run_timeout")
              throw failure;
            const evidence = await page.screenshot({
              path: screenshot,
              fullPage: false,
              mask: (config.screenshot?.mask ?? []).map((selector) => page.locator(selector)),
              maskColor: "#000000",
              timeout: Math.min(config.timeouts?.caseMs ?? 20000, 2000)
            }).then(() => screenshot).catch(() => null);
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
                ...failure.hint ? { hint: sanitizeDiagnosticText(failure.hint) } : {}
              }
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
  const manifest = join3(runDirectory, "manifest.json");
  const result = {
    schemaVersion: 1,
    success: true,
    pass: passed === cases.length,
    command: "verify",
    run: {
      id: runId,
      createdAt: new Date(startedAt).toISOString(),
      configDigest: configDigest(config),
      durationMs: Date.now() - startedAt,
      webServer: { managed: webServer !== undefined, reused: webServer?.reused ?? false }
    },
    cases,
    summary: { total: cases.length, passed, failed: cases.length - passed },
    manifest
  };
  await writeJsonAtomic(manifest, result);
  await writeJsonAtomic(join3(root, "latest.json"), { runId, manifest });
  await pruneRunDirectories(root, 3);
  return result;
}

// src/cli.ts
var HELP = `shimon ${TOOL_VERSION}

Usage:
  shimon selftest [--config <path>] [--json]
  shimon verify [--case <name>] [--config <path>] [--json]
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
  const caseNames = [];
  for (let index = 0;index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--case") {
      const caseName = argv[index + 1];
      if (!caseName || caseName.startsWith("--"))
        usage("--case requires a name.");
      caseNames.push(caseName);
      index += 1;
    } else if (argument.startsWith("--case=")) {
      const caseName = argument.slice("--case=".length);
      if (!caseName)
        usage("--case requires a name.");
      caseNames.push(caseName);
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
  if (!["capture", "diff", "help", "selftest", "verify", "version"].includes(command)) {
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
  if (caseNames.length > 0 && command !== "verify")
    usage("--case is only valid with verify.");
  return { command, labels: positionals, caseNames, json, configPath };
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
  const root = resolve3(cwd, ".shimon");
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
  if (args.command === "verify") {
    progress(`verifying ${publicTargetUrl(loaded.config.target.url)}`);
    const result = await verifyProject(loaded.config, {
      root,
      caseNames: args.caseNames,
      cwd,
      configPath: args.configPath
    });
    emit(result, args.json, result.pass ? "verification passed" : "verification failed");
    return result.pass ? 0 : 1;
  }
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
    const message = sanitizeDiagnosticText(failure.message);
    const hint = failure.hint ? sanitizeDiagnosticText(failure.hint) : undefined;
    const payload = {
      schemaVersion: 1,
      success: false,
      error: {
        code: failure.code,
        message,
        ...hint ? { hint } : {}
      }
    };
    if (json)
      process.stdout.write(`${JSON.stringify(payload)}
`);
    else
      process.stderr.write(`shimon: ${message}
`);
    return 2;
  }
}

// src/bin.ts
process.exitCode = await main();
