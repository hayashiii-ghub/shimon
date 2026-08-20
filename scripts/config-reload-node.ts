import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

const root = await mkdtemp(join(tmpdir(), "shimon-config-reload-"));

try {
  const configPath = join(root, "shimon.config.mjs");
  const taskPath = join(root, "task.mjs");
  await writeFile(
    configPath,
    `export default { target: { url: "http://127.0.0.1:1111/" }, cases: [{ name: "first" }] };`,
  );
  await writeFile(taskPath, `export default { cases: [{ name: "task-first" }] };`);
  const first = await loadConfig({ cwd: root, taskPath: "task.mjs" });

  await writeFile(
    configPath,
    `export default { target: { url: "http://127.0.0.1:2222/" }, cases: [{ name: "second" }] };`,
  );
  await writeFile(taskPath, `export default { cases: [{ name: "task-second" }] };`);
  const second = await loadConfig({ cwd: root, taskPath: "task.mjs" });

  assert.deepEqual(first.config.cases.map((testCase) => testCase.name), ["first", "task-first"]);
  assert.equal(second.config.target.url, "http://127.0.0.1:2222/");
  assert.deepEqual(second.config.cases.map((testCase) => testCase.name), ["second", "task-second"]);
} finally {
  await rm(root, { recursive: true, force: true });
}
