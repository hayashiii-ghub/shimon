import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shimon-check-reload-"));

try {
  const output = join(root, "config-reload-node.mjs");
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "config-reload-node.ts")],
    target: "node",
    format: "esm",
  });
  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n"));
  }
  const [artifact] = build.outputs;
  if (!artifact) throw new Error("Node config reload bundle was not generated.");
  await Bun.write(output, artifact);

  const result = Bun.spawnSync(["node", output], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`Node config reload check failed with exit code ${result.exitCode}.`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
