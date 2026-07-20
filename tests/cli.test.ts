import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { main, parseCliArgs } from "../src/cli.ts";

const roots: string[] = [];

function artifact(value: number): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    toolVersion: "0.0.1",
    target: { url: "http://127.0.0.1/" },
    environment: {
      browser: "chromium",
      browserVersion: "test",
      viewport: { width: 640, height: 480 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezone: "UTC",
    },
    cases: [{ name: "start", viewport: { width: 640, height: 480 }, probe: { value } }],
  })}\n`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseCliArgs", () => {
  test("parses repeated verify case filters", () => {
    expect(parseCliArgs(["verify", "--case", "home", "--case=mobile", "--json"])).toEqual({
      command: "verify",
      labels: [],
      caseNames: ["home", "mobile"],
      json: true,
      configPath: undefined,
    });
  });

  test("parses capture options independently of their position", () => {
    expect(parseCliArgs(["capture", "baseline", "--json", "--config", "custom.mjs"])).toEqual({
      command: "capture",
      labels: ["baseline"],
      caseNames: [],
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
    await writeFile(join(root, ".shimon", "before.json"), artifact(1));
    await writeFile(join(root, ".shimon", "after.json"), artifact(2));
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(await main(["diff", "before", "after", "--json"], root)).toBe(1);
      expect(stdout).toHaveBeenCalledWith(
        '{"ok":false,"command":"diff","before":"before","after":"after","changes":[{"path":"cases[0].probe.value","before":1,"after":2}]}\n',
      );
    } finally {
      stdout.mockRestore();
    }
  });

  test("runs one verify case and emits one JSON result", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-cli-"));
    roots.push(root);
    const html = '<html lang="en"><head><title>verify</title></head><body><main><h1>ready</h1></main></body></html>';
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: ${JSON.stringify(`data:text/html,${encodeURIComponent(html)}`)} },
        cases: [{ name: "home" }, { name: "other" }],
        probe: () => ({ ready: true }),
      };`,
    );
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(await main(["verify", "--case", "home", "--json"], root)).toBe(0);
      expect(stdout).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(stdout.mock.calls[0][0]));
      expect(payload).toMatchObject({
        success: true,
        pass: true,
        command: "verify",
        summary: { total: 1, passed: 1, failed: 0 },
        cases: [{ name: "home", reproduce: "shimon verify --case home --json" }],
      });
      expect(payload.cases[0].evidence.screenshot).toStartWith(root);
    } finally {
      stdout.mockRestore();
    }
  }, 30_000);

  test("emits operational errors as one JSON document on stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-cli-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "data:text/html,<h1>ready</h1>" },
        cases: [{ name: "home" }],
        probe: () => ({}),
      };`,
    );
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      expect(await main(["verify", "--case", "missing", "--json"], root)).toBe(2);
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({
        schemaVersion: 1,
        success: false,
        error: {
          code: "case_not_found",
          message: "Unknown case: missing",
          hint: "Available cases: home",
        },
      });
    } finally {
      stdout.mockRestore();
    }
  });

  test("sanitizes operational errors in human output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-cli-"));
    roots.push(root);
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: "data:text/html,<h1>ready</h1>" },
        cases: [{ name: "home" }],
        probe: () => ({}),
      };`,
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(
        await main(
          [
            "verify",
            "--case",
            "https://user:pass@127.0.0.1/api?token=url-secret#trace Authorization: Bearer abc123",
          ],
          root,
        ),
      ).toBe(2);
      const message = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(message).toContain("https://127.0.0.1/api");
      expect(message).not.toContain("url-secret");
      expect(message).not.toContain("abc123");
    } finally {
      stderr.mockRestore();
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
