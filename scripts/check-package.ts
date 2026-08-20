/**
 * npmへ入るファイルとPi拡張の最小ロードを軽量に確認する。
 * Chromiumを起動せず、pack時の配布漏れと古いCLI bundleを止めるために使う。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { createShimonTool } from "../extensions/pi/index.ts";
import manifest from "../package.json";

const requiredFiles = [
  "dist/cli.js",
  "extensions/pi/index.ts",
  "src/config.ts",
  "src/verify.ts",
  "README.md",
  "SKILL.md",
];

const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "shimon-package-check-"));

try {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", join(temporary, "npm-cache")],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error(packed.stderr || "npm pack --dry-run failed");
  }
  const [result] = JSON.parse(packed.stdout) as [{ files: Array<{ path: string }> }];
  const paths = new Set(result.files.map((file) => file.path));
  const missing = requiredFiles.filter((path) => !paths.has(path));
  if (missing.length > 0) throw new Error(`npm package is missing: ${missing.join(", ")}`);

  const tool = createShimonTool();
  if (tool.name !== "shimon_verify") throw new Error("Pi extension does not expose shimon_verify");

  const cli = spawnSync("node", [join(root, "dist/cli.js"), "--version"], { encoding: "utf8" });
  if (cli.status !== 0 || cli.stdout.trim() !== manifest.version) {
    throw new Error(`CLI version does not match package.json: ${cli.stdout.trim() || "no output"}`);
  }

  process.stdout.write("package check passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
