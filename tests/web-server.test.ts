import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startManagedWebServer } from "../src/web-server.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("startManagedWebServer", () => {
  test("starts the configured server and stops the process it owns", async () => {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
    const port = reservation.port;
    reservation.stop(true);
    const root = await mkdtemp(join(tmpdir(), "shimon-server-"));
    roots.push(root);
    const script = join(root, "server.ts");
    await writeFile(
      script,
      `Bun.serve({ port: ${port}, fetch: () => new Response("ready") });`,
    );
    const url = `http://127.0.0.1:${port}/`;

    const handle = await startManagedWebServer({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      url,
      reuseExisting: true,
      timeoutMs: 5_000,
      cwd: root,
    });

    expect(handle.reused).toBeFalse();
    expect(await fetch(url).then((response) => response.text())).toBe("ready");
    await handle.close();
    await expect(fetch(url)).rejects.toThrow();
  }, 15_000);
});
