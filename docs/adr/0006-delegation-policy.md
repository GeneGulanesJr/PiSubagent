# 0006. Delegation policy: justification-guided subagent spawning

## Status

Accepted (2026-10-05)

## Context

The `subagent` tool exposes three dispatch modes (single, parallel, chain)
and generous mechanical limits (`MAX_PARALLEL_TASKS = 8`, sliding-window
concurrency, per-provider caps). Nothing in the tool surface, however, guided
the parent model on **when delegation is warranted at all**. In practice that
bias pushes models toward over-delegation: spawning agents because the tool
exists, splitting sequential work across agents for its own sake, and paying
the token/latency cost of child sessions that add no net benefit.

Mechanical caps (ADR-0001, ADR-0005) bound _resource use per dispatch_ but
say nothing about the _decision to dispatch_. The decision lives in the
parent model's context — so the fix must be guidance the parent actually
reads, not another limiter in the scheduler.

## Decision

Guidance-first, enforcement-light, in four parts:

1. **Canonical policy** at `docs/delegation-policy.md`: the net-benefit test,
   good/poor delegation candidates, "main agent first / 0–1 subagents"
   default, explicit-user-permission semantics ("spawn subagents if needed" =
   permission, not a requirement), and the final principle (optimize for the
   best result, not maximum agent utilization).

2. **Condensed policy in the tool description** (`src/index.ts`): four
   sentences appended to the `subagent` tool description — the one piece of
   delegation-time text every parent model reads in every session. A pointer
   to the full policy is included.

3. **On-demand skill** at `skills/subagent-delegation/SKILL.md`: the decision
   checklist loads when a parent model is actively deliberating, without
   inflating the always-present description further.

4. **Soft enforcement** in dispatch: `POLICY_PARALLEL_WARN = 2`
   (`src/dispatch/limits.ts`). `runParallel` appends a one-line, non-blocking
   policy note to the parent-facing text when `tasks.length` exceeds it.
   Guidance only — never rejects, never flips `isError`.

**Rejected / deferred:** a mandatory `justification` string parameter on the
tool. It adds schema friction to every call (including the legitimate ones)
and audits a string rather than improving decisions; deferred until soft
guidance is shown to be insufficient.

## Consequences

- The tool description grows by four sentences: a small, permanent token cost
  per session, accepted because it is the only channel guaranteed to reach
  the deciding model.
- Fan-outs above 2 tasks carry a one-line reminder in their result text.
- No dispatch is ever blocked by the policy layer; existing limits
  (`MAX_PARALLEL_TASKS`, concurrency windows, provider caps) are unchanged.
- Tests cover the note threshold (present above, absent at/below, `isError`
  untouched).
