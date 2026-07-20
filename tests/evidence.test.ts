import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pruneRunDirectories, writeJsonAtomic } from "../src/evidence.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pruneRunDirectories", () => {
  test("keeps the three newest evidence runs without touching artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-evidence-"));
    roots.push(root);
    await mkdir(join(root, "runs"), { recursive: true });
    for (const [index, name] of ["oldest", "older", "newer", "newest"].entries()) {
      const directory = join(root, "runs", name);
      await mkdir(directory);
      await utimes(directory, index + 1, index + 1);
    }
    await Bun.write(join(root, "baseline.json"), "artifact");

    const removed = await pruneRunDirectories(root, 3);

    expect(removed).toEqual([join(root, "runs", "oldest")]);
    expect((await readdir(join(root, "runs"))).sort()).toEqual(["newer", "newest", "older"]);
    expect(await Bun.file(join(root, "baseline.json")).text()).toBe("artifact");
  });

  test("removes its temporary file when the atomic rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-evidence-"));
    roots.push(root);
    await mkdir(join(root, "manifest.json"));

    await expect(writeJsonAtomic(join(root, "manifest.json"), { ok: true })).rejects.toBeDefined();
    expect((await readdir(root)).sort()).toEqual(["manifest.json"]);
  });
});
