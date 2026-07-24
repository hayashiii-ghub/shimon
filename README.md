# shimon

Turn task-specific UI quality checks into repeatable evidence for coding agents.

The repository owns only the execution skeleton: target, development server,
named responsive widths, and security masks. For each change, an agent derives
the smallest useful cases and review criteria from the task and code, then
`shimon` runs those states in isolated browser contexts and returns structured
checks and screenshots.

Shimon does not decide whether a design is good and it does not impose a
component, token, or CSS system.

## Install

Shimon requires Node.js 22 or newer and Chromium for Playwright.

```sh
npm install --save-dev @hayashiii/shimon
npx playwright install chromium
```

Run the project-local CLI with `npx shimon`:

```sh
npx shimon verify --json
```

## Agent loop

```sh
npx shimon verify --json
npx shimon verify --case menu-mobile --json
```

One `verify` run launches Chromium once. Each case gets a fresh context and page,
then produces:

- the case URL, intent, named viewport, and screenshot review criteria;
- the agent-defined `probe` and project checks;
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
npx shimon selftest
npx shimon capture baseline
npx shimon capture current
npx shimon diff baseline current
```

`selftest` compares two fresh captures for nondeterminism. `capture` writes a
schema-versioned fingerprint atomically, and `diff` reports changed JSON paths.
Screenshots, durations, run IDs, and file paths are evidence and are not part of
fingerprint comparison.

## Project-owned skeleton

The default `shimon.config.mjs` can contain no cases. A project normally owns
only this stable skeleton:

```js
export default {
  target: { url: "http://127.0.0.1:4322/" },
  viewports: {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 768, height: 1024 },
    mobile: { width: 390, height: 844 },
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:4322/",
    reuseExisting: true,
    timeoutMs: 30_000,
  },
  timeouts: { runMs: 120_000, caseMs: 20_000, navigationMs: 10_000 },
  screenshot: { mask: ["[data-sensitive]", ".account-email"] },
};
```

Loading this skeleton is valid. Running it without any cases exits with the
operational error `cases_required`, so an empty run can never pass silently.

Named viewports are CSS viewport sizes, not full device emulation. They give
agents stable project-approved desktop, tablet, and mobile widths without
hard-coding widths into every task.

## Agent-authored task config

For a UI task, the agent creates an ephemeral `.shimon/task.config.mjs` that
extends the skeleton:

```js
import base from "../shimon.config.mjs";

export default {
  ...base,
  cases: [
    {
      name: "pricing-menu-mobile",
      path: "/pricing",
      viewport: "mobile",
      intent: "Verify the changed pricing menu at the narrow layout.",
      prepare: (page) => page.getByRole("button", { name: "Menu" }).click(),
      checks: [
        {
          id: "menu-visible",
          description: "The opened menu remains inside the viewport",
          async evaluate(page) {
            const menu = page.getByRole("navigation");
            return {
              pass: await menu.isVisible(),
              evidence: { links: await menu.getByRole("link").count() },
            };
          },
        },
      ],
      review: [
        "Menu hierarchy is clear",
        "Primary CTA remains prominent",
        "No content appears clipped or overlapped",
      ],
    },
  ],
  probe(page) {
    return page.evaluate(() => ({
      path: location.pathname,
      width: innerWidth,
    }));
  },
};
```

```sh
npx shimon verify --config .shimon/task.config.mjs --json
```

`path` is resolved against `target.url` and must start with a single `/`.
`prepare(page)` creates an interaction state. `checks` are machine-passable assertions and may
return a boolean or `{ pass, evidence }`. `review` contains visual questions for
the calling agent; shimon returns them with the screenshot but does not pretend
to judge them itself. Check evidence and probes must be JSON-serializable.

If the base config already contains durable cases, the task config should retain
them with `cases: [...(base.cases ?? []), ...taskCases]`. Agents must not delete
or weaken stable cases to make a change pass. Promote a task case into the base
config only when it expresses a durable product invariant.

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
