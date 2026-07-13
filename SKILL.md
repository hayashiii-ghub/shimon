---
name: shimon
description: Capture and compare deterministic, project-defined UI fingerprints.
---

# shimon

Use shimon when a repository includes `shimon.config.mjs` and a design or UI
change should preserve defined visual invariants.

## Workflow

1. Start the target application at the URL declared by its config.
2. Run `shimon selftest --json` before trusting any comparison.
3. Run `shimon capture baseline --json` before the change.
4. Implement the change.
5. Run `shimon capture current --json`.
6. Run `shimon diff baseline current --json` and inspect every changed path.

Treat exit code `1` as an observed UI mismatch, not an operational failure.
Treat exit code `2` as a broken invocation, config, target, or browser run.

Do not infer design quality from a passing fingerprint. It only proves that the
project-defined observations are equal. Do not weaken or delete probes merely
to make a change pass; update the config only when the intended invariant has
actually changed.

Never probe credentials, personal data, tokens, or authenticated content that
must not be persisted. Artifacts are stored on disk, and `diff --json` emits
changed values to stdout where CI or agent logs may retain them.

`shimon.config.mjs` is trusted executable code. Do not run it from an untrusted
repository.
