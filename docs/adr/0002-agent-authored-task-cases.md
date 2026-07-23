# ADR 0002: Agent-authored task cases

- Status: accepted
- Date: 2026-07-23

## Context

Projects can reliably define how to start their UI and which responsive widths
matter, but the routes, interaction states, and quality questions worth checking
change with every implementation task. Requiring humans to maintain every case
up front leaves the development loop stale or overly broad.

## Decision

The stable `shimon.config.mjs` may contain only the target, managed server,
named viewports, screenshot masks, and timeouts. An empty case list is valid at
load time but cannot be executed successfully.

For each task, the coding agent derives a small overlay config from the task,
diff, affected routes, and components. A case can select a named viewport, open
a project-relative path, prepare an interaction state, declare an intent, run
machine checks, and return visual review criteria with its screenshot.

Project checks return either a boolean or `{ pass, evidence }`. Their results
participate in the case pass/fail status. Review criteria do not: they are an
explicit handoff to the calling agent for screenshot judgment.

Stable repository cases are additive constraints. Agents may reuse and extend
them, but must not remove or weaken them merely to pass a task. A task case is
promoted to the base config only when it becomes a durable product invariant.

## Consequences

- Humans maintain a small, stable execution skeleton instead of a speculative
  checklist for every future change.
- Responsive widths stay consistent across tasks while case selection remains
  proportional to the changed UI.
- Evidence explains why a case exists and what the agent must visually inspect.
- Shimon remains an executor and evidence format; aesthetic judgment stays with
  the agent consuming its output.
