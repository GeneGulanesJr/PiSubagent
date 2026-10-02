# 0005. Provider-scoped concurrency caps for parallel dispatch

## Status

Accepted (2026-10-02)

## Context

Provider plans cap how many model requests an account may run concurrently —
the owner's z.ai plan allows **2**, the MiniMax plan allows **3**. Every
subagent is an independent model session spawned by the parent, so a parallel
dispatch can exceed those account limits before any single run misbehaves:
the visible symptom is provider-side throttling or request failures that look
like flaky agents.

ADR-0001 enforced the advertised `MAX_CONCURRENCY = 4` as a per-batch window
(`runParallel` chunked `tasks[]` into batches of 4 and awaited each batch's
`Promise.all`). That bounds total in-flight runs but cannot express
_per-provider_ slots: a single batch of 4 same-provider (z.ai) tasks would
already be 2× over that provider's cap, and batches are blind to which model
each task resolved to.

## Decision

1. **Provider attribution.** Each parallel task's provider is the prefix of
   its _resolved_ model id — after the full resolution ladder (dispatch
   `model` override → dispatch `tier` → agent frontmatter `model:` →
   agent frontmatter `tier:` → parent inheritance). `zai/glm-5.3-flash` →
   `zai`. Runs with no attributable provider (bare model id, or no model
   anywhere) are uncapped.

2. **Caps.** Built-in defaults in `src/provider-limits.ts`:
   `{ zai: 2, minimax: 3 }`, overridable via
   `~/.pi/agent/pisubagent.limits.json` (flat map provider → positive
   integer; invalid entries fall back to defaults; 0 is rejected because a
   zero-cap task could never start — a scheduler deadlock). Mirrors the
   `pisubagent.tiers.json` pattern (file reader is pure, load is cached,
   `resetProviderLimitsCache()` is the test seam).

3. **Scheduler.** Replace the ADR-0001 batch loop with a sliding window
   (`src/dispatch/schedule.ts` → `runWithCaps`): scan pending tasks in
   order and start any task whose constraints allow — total in-flight
   < `MAX_CONCURRENCY` **and** the task's provider below its cap. A blocked
   provider does not head-of-line block later tasks with free slots
   (mixed-provider batches keep flowing). Result order, progress emissions,
   retries, and structured-output handling in `runParallel` are unchanged.

## Consequences

### Positive

- Provider account limits are respected by default for the two providers the
  owner actually pays for; other providers are unaffected.
- Sliding window is strictly more utilitarian than batches: a slow z.ai task
  no longer idles free minimax/uncapped slots (ADR-0001's accepted
  head-of-line blocking is gone as a side effect).
- Caps are user-tunable without a code change (new provider plan → edit JSON).

### Negative

- Peak utilization for a single capped provider is lower than the total
  window (4 z.ai tasks now run 2-at-a-time instead of 4-at-a-time — that is
  the point).
- Failure semantics sharpened slightly: a `start()` rejection is no longer
  fail-fast (Promise.all threw while siblings kept running detached); the
  scheduler lets all in-flight tasks settle and then rethrows the first
  error. Same "the dispatch failed" contract for callers, without orphaned
  background promises.
- Tier-fallback runs (a failed tier-routed run retried on the parent model)
  attribute to the parent's provider _after_ being spawned under the tier
  provider's slot — the cap governs spawning, not mid-run model switches.

### Alternatives considered

- **Static batches sized to the min cap** (rejected): wastes the total window
  whenever providers are mixed, and still wrong — batch membership doesn't
  know models until resolution.
- **Global semaphore only** (rejected): a single cap of 2 would throttle
  uncapped providers for no reason; a single cap of 4 wouldn't protect z.ai.
- **Queue/reject excess tasks** (rejected): callers ask for N results; waiting
  is almost always preferable to a failed dispatch.
