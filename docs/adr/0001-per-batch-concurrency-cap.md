# 0001. Per-batch concurrency cap for runParallel

## Status

Accepted (2026-09-23, commit `940695e`)

## Context

The design spec (`docs/superpowers/specs/2026-09-08-pisubagent-design.md` § Limits) advertises `MAX_CONCURRENCY = 4` as a per-batch window — at most N runs in flight at any moment. Before this decision, `runParallel` fired every task via bare `Promise.all`, leaving the cap unenforced (API drift).

## Decision

Replace bare `Promise.all` with a per-batch loop in `runParallel`: chunk `tasks[]` into batches of size `MAX_CONCURRENCY`, await each batch's `Promise.all` before starting the next.

## Consequences

### Positive

- Cap enforced as advertised.
- Result order semantics preserved (`results[i]` indexed by task position).
- Progress emissions per batch are identical to the unbounded version.
- Test count: 97 → 105 (added a peak-in-flight regression test).

### Negative

- Head-of-line blocking: a slow task in batch 1 delays batch 2 even if batch 2 tasks would finish instantly.
- Acceptable for our use case (parallel subagent work is IO-bound on model APIs; tail latency dominates anyway).

### Alternatives considered

- **Sliding-window semaphore**: optimal utilization, but more code, harder to test deterministically. Defer until MAX_CONCURRENCY grows past ~8.
- **Bare `Promise.all` (rejected)**: the original; cap unenforced, that's the drift.
