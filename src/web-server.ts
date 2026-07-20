import { spawn, type ChildProcess } from "node:child_process";

import { ShimonError } from "./errors.ts";
import { publicTargetUrl } from "./url.ts";

export interface ManagedWebServerOptions {
  command: string;
  url: string;
  reuseExisting: boolean;
  timeoutMs: number;
  cwd: string;
}

export interface ManagedWebServerHandle {
  reused: boolean;
  close: () => Promise<void>;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 1_000)) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 1_000);
}

export async function startManagedWebServer(
  options: ManagedWebServerOptions,
): Promise<ManagedWebServerHandle> {
  if (await reachable(options.url)) {
    if (!options.reuseExisting) {
      throw new ShimonError(
        "web_server_already_running",
        `A server is already reachable at ${publicTargetUrl(options.url)}`,
      );
    }
    return { reused: true, close: async () => undefined };
  }

  const child = spawn(options.command, {
    cwd: options.cwd,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"],
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      await terminate(child);
      throw new ShimonError("web_server_start_failed", "Could not start the configured web server.", undefined, {
        cause: spawnError,
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
  throw new ShimonError(
    "web_server_timeout",
    `Web server did not become ready at ${publicTargetUrl(options.url)} within ${options.timeoutMs}ms.`,
  );
}
