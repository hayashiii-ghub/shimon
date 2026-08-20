import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import shimonForPi, { createShimonTool } from "../extensions/pi/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shimon pi extension", () => {
  test("registers the verification tool and status command", () => {
    const tools: string[] = [];
    const commands: string[] = [];

    shimonForPi({
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
    } as never);

    expect(tools).toEqual(["shimon_verify"]);
    expect(commands).toEqual(["shimon"]);
  });

  test("declares the Pi extension and shimon skill in the package manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./extensions/pi/index.ts"],
      skills: ["./SKILL.md"],
    });
  });

  test("reports zero-config readiness without a project config", async () => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const notifications: Array<{ message: string; level: string }> = [];

    shimonForPi({
      registerTool: () => undefined,
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as never);

    await handler?.("", {
      cwd: tmpdir(),
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    expect(notifications).toEqual([
      {
        message: "shimonはゼロ設定で利用できます。UI変更後にURLを指定してshimon_verifyを実行してください。",
        level: "info",
      },
    ]);
  });

  test("returns automated findings and screenshot images from one tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-pi-"));
    roots.push(root);
    const html = '<html lang="en"><head><title>verify</title></head><body><main><h1>ready</h1></main></body></html>';
    await writeFile(
      join(root, "shimon.config.mjs"),
      `export default {
        target: { url: ${JSON.stringify(`data:text/html,${encodeURIComponent(html)}`)} },
        cases: [{ name: "home", review: ["Heading is clear"] }],
      };`,
    );

    const tool = createShimonTool();
    const result = await tool.execute(
      "tool-call",
      {},
      new AbortController().signal,
      undefined,
      { cwd: root } as never,
    );

    expect(result.details).toMatchObject({
      success: true,
      pass: true,
      visualReviewRequired: true,
      summary: { total: 1, passed: 1, failed: 0 },
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    if (result.content[1]?.type === "image") {
      expect(result.content[1].data).toBe(
        (await readFile(result.details.cases[0].evidence.screenshot as string)).toString("base64"),
      );
    }
  }, 30_000);

  test("verifies an inline URL and cases without project configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-pi-"));
    roots.push(root);
    const html = '<html lang="ja"><head><title>inline</title></head><body><main><h1>設定不要</h1></main></body></html>';
    const tool = createShimonTool();

    const result = await tool.execute(
      "tool-call",
      {
        url: `data:text/html,${encodeURIComponent(html)}`,
        cases: [
          {
            name: "page",
            viewport: { width: 390, height: 844 },
            intent: "主要な内容がモバイル幅で読める",
            review: ["見出しと本文が画面内に収まる"],
          },
        ],
      },
      new AbortController().signal,
      undefined,
      { cwd: root } as never,
    );

    expect(result.details).toMatchObject({
      success: true,
      pass: true,
      visualReviewRequired: true,
      summary: { total: 1, passed: 1, failed: 0 },
      cases: [
        {
          name: "page",
          viewport: { width: 390, height: 844 },
          intent: "主要な内容がモバイル幅で読める",
          review: ["見出しと本文が画面内に収まる"],
          reproduce: 'Call shimon_verify again with the same url and inline case "page".',
        },
      ],
    });
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(result.details.manifest.startsWith(join(tmpdir(), "shimon-pi"))).toBe(true);
    await expect(access(join(root, ".shimon"))).rejects.toThrow();
  }, 30_000);

  test("reports zero-config guidance when neither a URL nor project config is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "shimon-pi-"));
    roots.push(root);
    const tool = createShimonTool();

    await expect(
      tool.execute(
        "tool-call",
        {},
        new AbortController().signal,
        undefined,
        { cwd: root } as never,
      ),
    ).rejects.toThrow("Pass url to shimon_verify");
  });
});
