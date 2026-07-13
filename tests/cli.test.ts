import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    const build = spawnSync("bun", ["run", "build"], { cwd: resolve(import.meta.dir, "..") });
    expect(build.status).toBe(0);
    const link = join(root, "shimon");
    await symlink(resolve(import.meta.dir, "../dist/cli.js"), link);

    const result = spawnSync(link, ["--version"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.0.1\n");
  });
});
