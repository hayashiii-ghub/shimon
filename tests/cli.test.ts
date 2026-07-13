import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { main, parseCliArgs } from "../src/cli.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseCliArgs", () => {
  test("parses capture options independently of their position", () => {
    expect(parseCliArgs(["capture", "baseline", "--json", "--config", "custom.mjs"])).toEqual({
      command: "capture",
      labels: ["baseline"],
      json: true,
      configPath: "custom.mjs",
    });
  });

  test("rejects missing diff labels", () => {
    expect(() => parseCliArgs(["diff", "before"])).toThrow("diff requires two labels");
  });

  test("returns exit code 1 when stored fingerprints differ", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-cli-"));
    roots.push(root);
    await mkdir(join(root, ".shimon"));
    await writeFile(join(root, ".shimon", "before.json"), '{"value":1}\n');
    await writeFile(join(root, ".shimon", "after.json"), '{"value":2}\n');
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(await main(["diff", "before", "after", "--json"], root)).toBe(1);
      expect(stdout).toHaveBeenCalledWith(
        '{"ok":false,"command":"diff","before":"before","after":"after","changes":[{"path":"value","before":1,"after":2}]}\n',
      );
    } finally {
      stdout.mockRestore();
    }
  });

  test("runs the packaged CLI through a bin symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-bin-"));
    roots.push(root);
    const link = join(root, "shimon");
    await symlink(resolve(import.meta.dir, "../dist/cli.js"), link);

    const result = spawnSync(link, ["--version"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.0.1\n");
  });

  test("keeps the tracked CLI bundle synchronized with its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-build-"));
    roots.push(root);
    const repository = resolve(import.meta.dir, "..");
    const output = join(root, "cli.js");
    const build = spawnSync(
      "bun",
      [
        "build",
        "src/bin.ts",
        "--target=node",
        "--format=esm",
        `--outfile=${output}`,
        "--banner=#!/usr/bin/env node",
        "--external=playwright",
      ],
      { cwd: repository },
    );
    expect(build.status).toBe(0);

    expect(await readFile(output, "utf8")).toBe(await readFile(join(repository, "dist/cli.js"), "utf8"));
  });

  test("includes the CLI bundle when packed from a GitHub-style source archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-archive-"));
    roots.push(root);
    const repository = resolve(import.meta.dir, "..");
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "dist/cli.js"], {
      cwd: repository,
    });
    expect(tracked.status).toBe(0);
    const tree = spawnSync("git", ["write-tree"], { cwd: repository, encoding: "utf8" });
    expect(tree.status).toBe(0);
    const archive = spawnSync("git", ["archive", "--format=tar", tree.stdout.trim()], {
      cwd: repository,
    });
    expect(archive.status).toBe(0);
    const extract = spawnSync("tar", ["-xf", "-"], { cwd: root, input: archive.stdout });
    expect(extract.status).toBe(0);

    const packed = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--cache", join(root, "npm-cache")],
      { cwd: root, encoding: "utf8" },
    );
    expect(packed.status).toBe(0);
    const [manifest] = JSON.parse(packed.stdout) as [{ files: Array<{ path: string }> }];

    expect(manifest.files.map((file) => file.path)).toContain("dist/cli.js");
  });
});
