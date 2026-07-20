# ADR 0001: Agent UI evidence runner

- Status: accepted
- Date: 2026-07-16

## Context

Coding agents need to reproduce a repository's meaningful UI states, gate them
on deterministic health checks, and inspect screenshots during implementation
and review. Running separate screenshot, check, and inspect commands starts and
navigates browsers repeatedly and can observe different page states.

Shimon already lets repositories define cases, preparation, and probes. Sitesnap
demonstrated useful screenshot, overflow, console, request, and accessibility
primitives, but also includes sitemap collection and archive management that do
not belong in an in-repository development loop.

## Decision

Shimon is the execution skeleton for project-defined UI quality checklists.
`verify` collects probes, built-in checks, and a masked viewport screenshot from
the same isolated case state and returns one structured result for an agent.

The browser process is shared per run, but every case receives a new context and
page. Fingerprint artifacts remain deterministic and separate from volatile run
evidence such as screenshots, paths, IDs, timestamps, and durations.

Managed development-server lifecycle, timeout budgets, case filtering, URL
redaction, screenshot masking, and stable exit codes are part of the agent API.
The run budget includes managed-server startup and expires as an operational
`run_timeout`; a case-only budget expires as an observed `case_timeout`.

## Boundary

A feature belongs in shimon only when it helps execute or observe a case defined
by the current repository. Arbitrary URL collection, sitemap crawling, archive
management, interactive human UI, pixel diffing, and aesthetic judgment do not
belong in shimon.

Screenshots are evidence for an agent to inspect, not fingerprint inputs and not
an invitation to add image-diff infrastructure.

## Consequences

- UI development can use one verify command instead of separate shot/check/
  inspect navigations.
- Repositories must define stable case names, preparation, masks, and probes.
- Accessibility and security masking remain part of the minimum product.
- Additional Playwright options are exposed only after multiple consumers show
  the same need.
