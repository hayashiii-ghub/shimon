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
function invalid(message, hint = "Check shimon.config.mjs.") {
  throw new ShimonError("config_invalid", message, hint);
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
  const config = validateConfig(module.default);
  if (!options.taskPath)
    return { path, config };
  const taskPath = isAbsolute(options.taskPath) ? options.taskPath : resolve(options.cwd, options.taskPath);
  try {
    await access(taskPath);
  } catch (error) {
    throw new ShimonError("task_not_found", `Task config not found: ${taskPath}`, "Create a task module with a default export containing cases, or omit --task.", { cause: error });
  }
  let taskModule;
  try {
    taskModule = await import(pathToFileURL(taskPath).href);
  } catch (error) {
    throw new ShimonError("task_load_failed", `Could not load task config: ${taskPath}`, undefined, {
      cause: error
    });
  }
  if (taskModule.default === null || typeof taskModule.default !== "object") {
    invalid("The task default export must be an object.", "Check the module passed to --task.");
  }
  const task = taskModule.default;
  const unexpected = Object.keys(task).filter((key) => key !== "cases");
  if (unexpected.length > 0) {
    invalid(`Task config only accepts cases; remove: ${unexpected.join(", ")}`, "Move project settings to shimon.config.mjs.");
  }
  const taskCases = validateCases(task.cases, config.viewports ?? {});
  const names = new Set(config.cases.map((testCase) => testCase.name));
  const duplicate = taskCases.find((testCase) => names.has(testCase.name));
  if (duplicate) {
    invalid(`Task case duplicates a project case: ${duplicate.name}`, "Give the task case a unique name.");
  }
  return {
    path,
    taskPath,
    config: { ...config, cases: [...config.cases, ...taskCases] }
  };
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

// src/version.ts
var TOOL_VERSION = "0.3.0";

// src/verify.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join as join2, resolve as resolve2 } from "node:path";
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
async function settle(page) {
  await page.evaluate(() => new Promise((resolve2) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve2()));
  }));
}
async function prepareConfiguredCase(page, config, testCase, execute = async (promise) => promise) {
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
}

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
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}
`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function pruneRunDirectories(root, keep) {
  const runs = join(root, "runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(runs, entry.name);
    return { path, mtimeMs: (await stat(path)).mtimeMs };
  }));
  directories.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  const removed = directories.slice(0, Math.max(0, directories.length - keep)).map((entry) => entry.path);
  await Promise.all(removed.map((path) => rm(path, { recursive: true, force: true })));
  return removed;
}

// src/json.ts
function asJsonValue(value, path = "evidence") {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (Array.isArray(value))
    return value.map((child, index) => asJsonValue(child, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ShimonError("evidence_invalid", `${path} must be a plain JSON object.`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, asJsonValue(child, `${path}.${key}`)]));
  }
  throw new ShimonError("evidence_invalid", `${path} is not JSON-serializable.`, "Return only objects, arrays, strings, finite numbers, booleans, or null from check evidence.");
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
    throw new ShimonError("cases_required", "No verification cases are configured.", "Create an agent-authored task config with at least one case and pass --task <path>.");
  }
  const startedAt = Date.now();
  const runDeadline = startedAt + (config.timeouts?.runMs ?? 120000);
  const requestedCases = options.caseNames ?? [];
  const knownCases = new Set(config.cases.map((testCase) => testCase.name));
  const unknownCase = requestedCases.find((name) => !knownCases.has(name));
  if (unknownCase) {
    throw new ShimonError("case_not_found", `Unknown case: ${unknownCase}`, `Available cases: ${config.cases.map((testCase) => testCase.name).join(", ")}`);
  }
  const runId = randomUUID2();
  const root = resolve2(options.root);
  const runDirectory = join2(root, "runs", runId);
  const screenshotDirectory = join2(runDirectory, "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
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
  const reproduce = (caseName) => `shimon verify --case ${caseName}${options.configPath ? ` --config ${JSON.stringify(options.configPath)}` : ""}${options.taskPath ? ` --task ${JSON.stringify(options.taskPath)}` : ""} --json`;
  try {
    const browser = await beforeDeadline(chromium.launch({ headless: true }), runDeadline, "run_timeout", "Verification run timed out while launching Chromium.");
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
        const screenshot = join2(screenshotDirectory, caseFilename(caseIndex, testCase.name));
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
            await prepareConfiguredCase(page, config, testCase, withinCase);
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
  const manifest = join2(runDirectory, "manifest.json");
  const result = {
    schemaVersion: 1,
    success: true,
    pass: passed === cases.length,
    visualReviewRequired: cases.some((testCase) => testCase.evidence.screenshot !== null),
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
  await writeJsonAtomic(join2(root, "latest.json"), { runId, manifest });
  await pruneRunDirectories(root, 3);
  return result;
}

// src/cli.ts
var HELP = `shimon ${TOOL_VERSION}

Usage:
  shimon verify [--case <name>] [--config <path>] [--task <path>] [--json]
`;
function usage(message) {
  throw new ShimonError("usage_error", message, "Run shimon --help for usage.");
}
function parseCliArgs(argv) {
  const positionals = [];
  const caseNames = [];
  let json = false;
  let configPath;
  let taskPath;
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
    } else if (argument === "--task") {
      taskPath = argv[index + 1];
      if (!taskPath || taskPath.startsWith("--"))
        usage("--task requires a path.");
      index += 1;
    } else if (argument.startsWith("--task=")) {
      taskPath = argument.slice("--task=".length);
      if (!taskPath)
        usage("--task requires a path.");
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
  if (!["help", "verify", "version"].includes(command))
    usage(`Unknown command: ${command}`);
  if (positionals.length > 0)
    usage(`${command} does not accept labels.`);
  if (command !== "verify" && (caseNames.length > 0 || configPath || taskPath)) {
    usage("--case, --config, and --task are only valid with verify.");
  }
  return { command, caseNames, json, configPath, taskPath };
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
  const loaded = await loadConfig({
    cwd,
    configPath: args.configPath,
    taskPath: args.taskPath
  });
  progress(`verifying ${publicTargetUrl(loaded.config.target.url)}`);
  const result = await verifyProject(loaded.config, {
    root,
    caseNames: args.caseNames,
    cwd,
    configPath: args.configPath,
    taskPath: args.taskPath
  });
  const screenshotCount = result.cases.filter((testCase) => testCase.evidence.screenshot).length;
  const human = !result.pass ? "verification failed" : result.visualReviewRequired ? `automated checks passed; inspect ${screenshotCount} screenshot${screenshotCount === 1 ? "" : "s"}` : "automated checks passed";
  emit(result, args.json, human);
  return result.pass ? 0 : 1;
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
