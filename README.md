# shimon

Deterministic UI fingerprints for agent-driven design work.

`shimon` turns the visual invariants a project cares about into stable JSON. It
does not decide whether a design is good, and it does not impose a component or
token system. The repository defines its own states and probes in executable
JavaScript; shimon makes those observations repeatable and diffable.

## Commands

```sh
shimon selftest
shimon capture baseline
shimon capture current
shimon diff baseline current
```

Run `selftest` first. It makes two fresh browser captures and fails when the
harness itself is nondeterministic. `capture` writes `.shimon/<label>.json`
atomically, and `diff` reports every changed JSON path.

Use `--json` for machine-readable stdout and `--config <path>` to select a
non-default config. Exit codes are `0` for success or equality, `1` for a real
fingerprint mismatch, and `2` for usage, configuration, or runtime errors.

## Config

The default file is `shimon.config.mjs`:

```js
export default {
  target: {
    url: "http://127.0.0.1:4322/",
    viewport: { width: 1200, height: 900 },
  },

  async stabilize(page) {
    await page.evaluate(() => document.fonts.ready);
  },

  cases: [
    { name: "start" },
    {
      name: "menu-open",
      prepare: (page) => page.getByRole("button", { name: "Menu" }).click(),
    },
  ],

  probe(page) {
    return page.evaluate(() => ({
      menuTransform: getComputedStyle(document.querySelector("nav")).transform,
      selectedItem: document.querySelector("[aria-current=page]")?.textContent ?? null,
    }));
  },
};
```

Animations and transitions are disabled before stabilization by default. Set
`freezeAnimations: false` only when motion itself is the invariant being
measured. A probe must return JSON data.

Do not return credentials, personal data, session state, or access tokens from
`probe`. Artifacts persist probe values on disk, and `diff --json` writes changed
values to stdout. Target credentials, query parameters, and fragments are
removed from logs and artifact metadata before they are recorded.

The config is trusted executable code with access to Node.js and the browser.
Only run shimon in repositories you trust.

## Development

```sh
bun install
npx playwright install chromium
bun test
bun run typecheck
bun run build
```
