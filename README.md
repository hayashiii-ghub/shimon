# shimon

Turn project-defined UI quality checks into repeatable evidence for coding agents.

`shimon` runs repository-owned UI states in isolated browser contexts and returns
the probe values, health checks, and screenshots an agent needs to judge a UI
change. It does not decide whether a design is good and it does not impose a
component, token, or CSS system.

## Agent loop

```sh
shimon verify --json
shimon verify --case menu-mobile --json
```

One `verify` run launches Chromium once. Each case gets a fresh context and page,
then produces:

- the project-defined `probe`;
- overflow offenders with selectors and boxes;
- console and uncaught page errors;
- failed requests with redacted URLs;
- axe accessibility violations;
- a viewport screenshot with configured sensitive elements masked.

The JSON contains absolute screenshot paths and a `reproduce` command for every
case. Evidence is written under `.shimon/runs/<run-id>/`; `.shimon/latest.json`
points to the latest manifest and only the three newest runs are retained.

Exit codes are `0` when every case passes, `1` for an observed case or health
failure, and `2` for usage, config, managed-server, browser, or other operational
errors. With `--json`, stdout always contains exactly one JSON document; progress
goes to stderr.

## Fingerprints

```sh
shimon selftest
shimon capture baseline
shimon capture current
shimon diff baseline current
```

`selftest` compares two fresh captures for nondeterminism. `capture` writes a
schema-versioned fingerprint atomically, and `diff` reports changed JSON paths.
Screenshots, durations, run IDs, and file paths are evidence and are not part of
fingerprint comparison.

## Config

The default file is `shimon.config.mjs`:

```js
export default {
  target: {
    url: "http://127.0.0.1:4322/",
    viewport: { width: 1200, height: 900 },
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:4322/",
    reuseExisting: true,
    timeoutMs: 30_000,
  },
  timeouts: { runMs: 120_000, caseMs: 20_000, navigationMs: 10_000 },
  screenshot: { mask: ["[data-sensitive]", ".account-email"] },
  cases: [
    { name: "home" },
    {
      name: "menu-mobile",
      viewport: { width: 390, height: 844 },
      prepare: (page) => page.getByRole("button", { name: "Menu" }).click(),
    },
  ],
  async stabilize(page) {
    await page.evaluate(() => document.fonts.ready);
  },
  probe(page) {
    return page.evaluate(() => ({
      menuTransform: getComputedStyle(document.querySelector("nav")).transform,
      selectedItem: document.querySelector("[aria-current=page]")?.textContent ?? null,
    }));
  },
};
```

Animations and transitions are disabled before stabilization by default. Set
`freezeAnimations: false` only when motion itself is the invariant. Case names
are stable machine identifiers and use letters, numbers, dots, dashes, or
underscores.

When `webServer` is configured, shimon reuses an already reachable server or
starts the command and stops only the process it owns. The config is trusted
executable code with access to Node.js and the browser; only run it in
repositories you trust.

## Security boundary

Do not return credentials, personal data, session state, or access tokens from
`probe`. Mask sensitive elements before screenshots are persisted. Target and
request credentials, query parameters, and fragments are removed from recorded
metadata and JSON output.

Shimon screenshots are evidence for an agent to inspect. Shimon does not perform
pixel diffing, aesthetic judgment, arbitrary URL collection, sitemap crawling,
or archive management.

Console errors, uncaught page errors, request failures, accessibility selectors,
and probe values are also persisted in the manifest and may be copied into agent
or CI logs. Diagnostic strings have a fixed length limit and redact HTTP(S) URL
credentials/query/fragment plus common secret fields, but this is best-effort;
applications must not log secrets or personal data. Screenshot masks apply only
to image pixels, not to probe values or browser diagnostics.

## Development

```sh
bun install
npx playwright install chromium
bun test
bun run typecheck
bun run build
```
