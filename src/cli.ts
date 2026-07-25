import { resolve } from "node:path";

import { loadConfig } from "./config.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import { operationalError, ShimonError } from "./errors.ts";
import { publicTargetUrl } from "./url.ts";
import { TOOL_VERSION } from "./version.ts";
import { verifyProject } from "./verify.ts";

type Command = "help" | "verify" | "version";

export interface CliArgs {
  command: Command;
  caseNames: string[];
  json: boolean;
  configPath?: string;
  taskPath?: string;
}

const HELP = `shimon ${TOOL_VERSION}

Usage:
  shimon verify [--case <name>] [--config <path>] [--task <path>] [--json]
`;

function usage(message: string): never {
  throw new ShimonError("usage_error", message, "Run shimon --help for usage.");
}

export function parseCliArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const caseNames: string[] = [];
  let json = false;
  let configPath: string | undefined;
  let taskPath: string | undefined;

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
    } else if (argument === "--task") {
      taskPath = argv[index + 1];
      if (!taskPath || taskPath.startsWith("--")) usage("--task requires a path.");
      index += 1;
    } else if (argument.startsWith("--task=")) {
      taskPath = argument.slice("--task=".length);
      if (!taskPath) usage("--task requires a path.");
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
  if (!["help", "verify", "version"].includes(command)) usage(`Unknown command: ${command}`);
  if (positionals.length > 0) usage(`${command} does not accept labels.`);
  if (command !== "verify" && (caseNames.length > 0 || configPath || taskPath)) {
    usage("--case, --config, and --task are only valid with verify.");
  }

  return { command, caseNames, json, configPath, taskPath };
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
  const loaded = await loadConfig({
    cwd,
    configPath: args.configPath,
    taskPath: args.taskPath,
  });
  progress(`verifying ${publicTargetUrl(loaded.config.target.url)}`);
  const result = await verifyProject(loaded.config, {
    root,
    caseNames: args.caseNames,
    cwd,
    configPath: args.configPath,
    taskPath: args.taskPath,
  });
  const screenshotCount = result.cases.filter((testCase) => testCase.evidence.screenshot).length;
  const human = !result.pass
    ? "verification failed"
    : result.visualReviewRequired
      ? `automated checks passed; inspect ${screenshotCount} screenshot${screenshotCount === 1 ? "" : "s"}`
      : "automated checks passed";
  emit(result, args.json, human);
  return result.pass ? 0 : 1;
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
