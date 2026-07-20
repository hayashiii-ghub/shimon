import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactPath, readArtifact, writeArtifact } from "../src/store.ts";

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

  test("rejects artifacts that do not use the current schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-store-"));
    roots.push(root);
    await writeFile(join(root, "legacy.json"), '{"schemaVersion":1}\n');

    await expect(readArtifact(root, "legacy")).rejects.toMatchObject({
      code: "artifact_incompatible",
    });
  });

  test("rejects malformed artifacts that claim the current schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-store-"));
    roots.push(root);
    await writeFile(
      join(root, "malformed.json"),
      JSON.stringify({
        schemaVersion: 2,
        toolVersion: "0.0.1",
        target: { url: "https://example.com/" },
        environment: {},
        cases: [1],
      }),
    );

    await expect(readArtifact(root, "malformed")).rejects.toMatchObject({
      code: "artifact_invalid",
    });
  });
});
