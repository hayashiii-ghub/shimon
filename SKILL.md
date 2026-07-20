---
name: shimon
description: Run project-defined UI quality checks and return agent-readable evidence.
---

# shimon

Use shimon when a trusted repository includes `shimon.config.mjs` and a UI,
layout, or interaction change needs visual verification.

## Development loop

1. Run the repository's `ui:verify` script when present; otherwise run
   `shimon verify --json`.
2. Treat exit code `1` as an observed UI or case failure and exit code `2` as a
   broken invocation, config, server, or browser run.
3. Read every screenshot path returned by the JSON and inspect the image.
4. Check overflow, console errors, failed requests, and a11y before reporting
   the UI step complete.
5. After a fix, run the failed case's returned `reproduce` command. Run the full
   verify command once focused cases pass.

The configured web server is started and stopped automatically when necessary.
Do not start a second server when `run.webServer.reused` is true.

## Fingerprint comparison

Use `selftest`, `capture`, and `diff` when the task requires comparison with a
stored project-defined fingerprint. Do not infer design quality from an equal
fingerprint; it only proves that configured observations are equal.

Never weaken probes or health checks merely to make a change pass. Never probe
credentials, personal data, tokens, or authenticated content that must not be
persisted. Confirm that sensitive content is covered by `screenshot.mask`.

`shimon.config.mjs` is trusted executable code. Do not run it from an untrusted
repository.
