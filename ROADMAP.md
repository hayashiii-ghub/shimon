# Roadmap

Shimon provides the execution skeleton for project-defined UI quality checks:
repositories own states and probes, while shimon makes their checks and evidence
repeatable for coding agents.

## Current boundary

- `verify` returns project probes, built-in health checks, and masked viewport
  screenshots from the same isolated case state.
- `capture`, `diff`, and `selftest` keep deterministic fingerprints separate
  from volatile evidence.
- One Chromium process is shared per run; every case gets a fresh context/page.
- Managed server readiness, case selection, timeout budgets, and structured JSON
  errors are part of the agent contract.

See [ADR 0001](docs/adr/0001-agent-ui-evidence-runner.md).

## Near term

### Artifact compatibility

- Separate incompatible capture environments from actual probe-value changes.
- Decide whether browser, tool, locale, timezone, and target changes are errors
  or warnings.
- Document the schema migration policy before a public release.

### Reproducible browser context

- Decide fixed defaults for locale, timezone, color scheme, and device scale.
- Expose only context options proven necessary by real consumers.
- Keep navigation readiness project-defined rather than requiring network idle.

### Distribution

- Add CI for tests, type checking, package build, and bin-symlink smoke testing.
- Test supported Node.js and Playwright versions on macOS and Linux.
- Pilot with two structurally different consumers.
- Remove `private: true` and publish only after the command and artifact
  contracts survive those pilots.

### Agent ergonomics

- Consider a paths-only diff mode for logs that should not contain probe values.
- Add failure traces only if screenshots and structured diagnostics prove
  insufficient in real failures.
- Add `init` or `doctor` only after repeated setup failures define their scope.

## Intentionally out of scope

- Pixel-image diffing or AI judgment of aesthetic quality.
- Arbitrary URL collection, sitemap crawling, portfolio archives, or history UI.
- A design-token, component, or CSS architecture imposed on consumers.
- A browser interaction DSL beyond repository-owned `prepare(page)`.
- A plugin system before multiple consumers demonstrate a repeated boundary.
- Running config from untrusted repositories.

## Release readiness

A public release should have:

- deterministic selftests and verify runs in at least two real consumers;
- documented artifact and verify-result compatibility behavior;
- a passing package-install and bin-symlink smoke test;
- CI on the supported runtime matrix;
- no credentials or personal data in fixtures, artifacts, or screenshots.
