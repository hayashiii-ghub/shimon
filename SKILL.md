---
name: shimon
description: Derive task-specific UI cases from a code change, run them at project-approved responsive widths, and inspect agent-readable evidence.
---

# shimon

Use shimon when a trusted repository includes `shimon.config.mjs` and a UI,
layout, or interaction change needs visual verification. The repository may
define only an execution skeleton; author the task cases yourself.

## Author the cases

Before running shimon:

1. Read the task, diff, affected routes, and changed components.
2. Reuse all durable cases already present in `shimon.config.mjs`.
3. Create `.shimon/task.config.mjs` importing `../shimon.config.mjs`.
4. Add 2-5 minimal cases covering the affected route, state, and meaningful
   responsive widths. Avoid a full route-by-viewport matrix.
5. Put deterministic facts in `checks` or `probe`. Put visual questions that
   require judgment in `review`.

Use the affected primary width. Add `mobile` for structural layout changes. Add
`tablet` only when an intermediate breakpoint, grid transition, navigation, or
touch layout is plausibly at risk. Use `prepare(page)` for menus, dialogs, tabs,
expanded sections, validation states, or other interaction states introduced or
changed by the task.

Each case should have a stable `name`, project-relative `path`, named `viewport`,
one-sentence `intent`, and concrete `review` items. Checks should report compact
JSON evidence that helps diagnose failure. Never place credentials, tokens,
personal data, or session state in check evidence or probes.

## Development loop

1. Run the repository's `ui:verify` script when it covers the task config;
   otherwise run `shimon verify --config .shimon/task.config.mjs --json`.
2. Treat exit code `1` as an observed UI or case failure and exit code `2` as a
   broken invocation, config, server, or browser run.
3. Read every screenshot path returned by the JSON and inspect the image against
   that case's `intent` and every `review` item.
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

Never remove or weaken stable cases, probes, or health checks merely to make a
change pass. Keep task configs ephemeral unless a case expresses a durable
product invariant worth promoting to `shimon.config.mjs`. Never probe
credentials, personal data, tokens, or authenticated content that must not be
persisted. Confirm that sensitive content is covered by `screenshot.mask`.

`shimon.config.mjs` is trusted executable code. Do not run it from an untrusted
repository.
