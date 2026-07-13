# Roadmap

shimon starts deliberately small: a repository owns its browser states and
probes, while shimon makes their JSON output deterministic, persistent, and
diffable. The next work should strengthen that boundary before adding a larger
framework.

## Near term

### Artifact compatibility

- Validate `schemaVersion` and the required artifact shape when reading files.
- Separate incompatible capture environments from actual probe-value changes.
- Decide whether browser, tool, locale, timezone, and target changes are errors,
  warnings, or ordinary fingerprint differences.
- Define a migration policy before introducing artifact schema version 2.

### Reproducible browser context

- Decide fixed defaults for locale, timezone, color scheme, and device scale.
- Expose only the context options proven necessary by real consumers.
- Keep navigation readiness project-defined; do not return to an unconditional
  `networkidle` requirement.

### Distribution

- Add CI for tests, type checking, package build, and bin-symlink smoke testing.
- Test the supported Node.js and Playwright versions on macOS and Linux.
- Remove `private: true` and publish `@hayashiii/shimon` when the command and
  artifact contracts are stable enough for a first public release.
- Add release notes and keep the CLI version sourced from package metadata.

### Agent ergonomics

- Consider a paths-only diff mode for logs that should not contain probe values.
- Improve operational errors without exposing target credentials or query data.
- Add `init` or `doctor` only after repeated setup failures show what they must
  diagnose; avoid generating a large config abstraction preemptively.

### More consumers

- Use `cookie-demo` as the first full consumer and document its design harness.
- Add a second, structurally different consumer before extracting shared probe
  helpers or introducing a plugin API.
- Confirm that click, hover, responsive, and modal cases fit the existing
  `prepare` plus `probe` model.

## Intentionally out of scope

- Screenshot or pixel-image diffing.
- AI judgment about whether a design is aesthetically good.
- A design-token, component, or CSS architecture imposed on consumers.
- A plugin system before multiple consumers demonstrate a repeated boundary.
- Running config from untrusted repositories; `shimon.config.mjs` is executable
  code and remains a trusted-project boundary.

## Release readiness

A public release should have:

- deterministic selftests in at least two real consumers;
- documented artifact compatibility behavior;
- a passing package-install and bin-symlink smoke test;
- CI on the supported runtime matrix;
- no credentials or personal data in fixtures, artifacts, or examples.
