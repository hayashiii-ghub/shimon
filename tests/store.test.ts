import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactPath, writeArtifact } from "../src/store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact store", () => {
  test("atomically replaces a label with canonical JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-store-"));
    roots.push(root);

    await writeArtifact(root, "baseline", { z: 1, a: { y: 2, x: 1 } });
    await writeArtifact(root, "baseline", { current: true });

    expect(await readFile(join(root, "baseline.json"), "utf8")).toBe(
      '{"current":true}\n',
    );
    expect(await readdir(root)).toEqual(["baseline.json"]);
  });

  test("rejects labels that can escape the artifact directory", () => {
    expect(() => artifactPath(".shimon", "../outside")).toThrow("Invalid label");
    expect(() => artifactPath(".shimon", "..")).toThrow("Invalid label");
  });
});
