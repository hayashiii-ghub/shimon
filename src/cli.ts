import { resolve } from "node:path";

import type { JsonValue } from "./canonicalize.ts";
import { loadConfig } from "./config.ts";
import { diffJson } from "./diff.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import { operationalError, ShimonError } from "./errors.ts";
import { captureFingerprint } from "./runner.ts";
import { readArtifact, writeArtifact } from "./store.ts";
import { publicTargetUrl } from "./url.ts";
import { TOOL_VERSION } from "./version.ts";
import { verifyProject } from "./verify.ts";

type Command = "capture" | "diff" | "help" | "selftest" | "verify" | "version";

export interface CliArgs {
  command: Command;
  labels: string[];
  caseNames: string[];
  json: boolean;
  configPath?: string;
}

const HELP = `shimon ${TOOL_VERSION}

Usage:
  shimon selftest [--config <path>] [--json]
  shimon verify [--case <name>] [--config <path>] [--json]
  shimon capture <label> [--config <path>] [--json]
  shimon diff <before> <after> [--json]
`;

function usage(message: string): never {
  throw new ShimonError("usage_error", message, "Run shimon --help for usage.");
}

export function parseCliArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  let json = false;
  let configPath: string | undefined;
  const caseNames: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--case") {
      const caseName = argv[index + 1];
      if (!caseName || caseName.startsWith("--")) usage("--case requires a name.");
      caseNames.push(caseName);
      index += 1;
    } else if (argument.startsWith("--case=")) {
      const caseName = argument.slice("--case=".length);
      if (!caseName) usage("--case requires a name.");
      caseNames.push(caseName);
    } else if (argument === "--config") {
      configPath = argv[index + 1];
      if (!configPath || configPath.startsWith("--")) usage("--config requires a path.");
      index += 1;
    } else if (argument.startsWith("--config=")) {
      configPath = argument.slice("--config=".length);
      if (!configPath) usage("--config requires a path.");
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

  const command = (positionals.shift() ?? "help") as Command;
  if (!["capture", "diff", "help", "selftest", "verify", "version"].includes(command)) {
    usage(`Unknown command: ${command}`);
  }

  const required = command === "capture" ? 1 : command === "diff" ? 2 : 0;
  if (positionals.length !== required) {
    if (command === "capture") usage("capture requires one label.");
    if (command === "diff") usage("diff requires two labels.");
    usage(`${command} does not accept labels.`);
  }
  if (caseNames.length > 0 && command !== "verify") usage("--case is only valid with verify.");

  return { command, labels: positionals, caseNames, json, configPath };
}

function emit(value: unknown, json: boolean, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human}\n`);
}

function progress(message: string): void {
  process.stderr.write(`[shimon] ${message}\n`);
}

async function run(args: CliArgs, cwd: string): Promise<number> {
  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }

  const root = resolve(cwd, ".shimon");
  if (args.command === "diff") {
    const [beforeLabel, afterLabel] = args.labels;
    const before = await readArtifact(root, beforeLabel);
    const after = await readArtifact(root, afterLabel);
    const changes = diffJson(before, after);
    const identical = changes.length === 0;
    emit(
      { ok: identical, command: "diff", before: beforeLabel, after: afterLabel, changes },
      args.json,
      identical
        ? `${beforeLabel} and ${afterLabel} are identical`
        : `${beforeLabel} and ${afterLabel} differ at ${changes.length} path(s)`,
    );
    return identical ? 0 : 1;
  }

  const loaded = await loadConfig({ cwd, configPath: args.configPath });
  if (args.command === "verify") {
    progress(`verifying ${publicTargetUrl(loaded.config.target.url)}`);
    const result = await verifyProject(loaded.config, {
      root,
      caseNames: args.caseNames,
      cwd,
      configPath: args.configPath,
    });
    emit(result, args.json, result.pass ? "verification passed" : "verification failed");
    return result.pass ? 0 : 1;
  }
  if (args.command === "capture") {
    const label = args.labels[0];
    progress(`capturing ${label} from ${publicTargetUrl(loaded.config.target.url)}`);
    const artifact = await captureFingerprint(loaded.config);
    const path = await writeArtifact(root, label, artifact as unknown as JsonValue);
    emit(
      { ok: true, command: "capture", label, path, cases: artifact.cases.length },
      args.json,
      `captured ${label} -> ${path}`,
    );
    return 0;
  }

  progress(`capturing two fresh runs from ${publicTargetUrl(loaded.config.target.url)}`);
  const first = await captureFingerprint(loaded.config);
  const second = await captureFingerprint(loaded.config);
  const changes = diffJson(first as unknown as JsonValue, second as unknown as JsonValue);
  const stable = changes.length === 0;
  emit(
    { ok: stable, command: "selftest", changes },
    args.json,
    stable ? "selftest passed: two fresh captures are identical" : `selftest failed at ${changes.length} path(s)`,
  );
  return stable ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
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
        ...(hint ? { hint } : {}),
      },
    };
    if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`shimon: ${message}\n`);
    return 2;
  }
}
