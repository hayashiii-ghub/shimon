const groups = [
  [
    "tests/config.test.ts",
    "tests/diagnostics.test.ts",
    "tests/evidence.test.ts",
    "tests/json.test.ts",
    "tests/url.test.ts",
    "tests/web-server.test.ts",
  ],
  ["tests/verify.test.ts"],
  ["tests/cli.test.ts"],
  ["tests/pi-extension.test.ts"],
];

for (const files of groups) {
  const result = Bun.spawnSync(["bun", "test", ...files], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
