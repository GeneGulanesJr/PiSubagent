# 0006. Loop resilience: launch retry, JSONL dead-letter capture, chain circuit breaker

## Status

Accepted (2026-10-05). Implements issue #2, narrowed against what had already
landed since it was written.

## Context

Issue #2 (opened against v0.1.5) proposed three loop-engineering improvements:
a chain-mode circuit breaker, launch-failure retry with backoff, and
malformed-JSONL dead-letter capture. By the time implementation started, two
of its premises had gone stale:

- **Chain mode already stopped at the first failed step** (`runChain` early-
  returns "Chain stopped at step N"), so the "later steps run with poisoned
  input" problem no longer reproduced. What was genuinely missing was the
  configurable tolerance the issue asked for and any reporting of the
  untouched steps (they silently vanished from `details.results`).
- **Malformed-JSONL drops were already tallied** (Bug 7: a single end-of-run
  stderr count). What was missing was capturing _what_ dropped.
- Result-level retry with exponential backoff already existed
  (`runWithRetries`: per-step `retries`, `retryBackoffMs`, `retryOn`, tier
  fallback), but it is opt-in per dispatch/step and re-runs the _whole_ task;
  nothing distinguished a child that died at launch from one that ran and
  genuinely failed.

## Decision

1. **Launch-phase retry lives in the runner, not the dispatcher.**
   `SubprocessRunner.run` classifies an attempt as a _launch failure_ when
   either the spawn emits an `error` event (ENOMEM/EAGAIN class) or the
   process exits non-zero within a 100 ms launch window having produced zero
   `message_end` events. Launch failures are retried up to 3 times with
   exponential backoff — base 1 s, ×2 per attempt, ±20 % jitter so sibling
   dispatches don't retry in lockstep. Real agent output, success, aborts,
   timeouts, and exits past the window are final here; the outer
   `runWithRetries` still applies on top (inner fast launch retry, slower
   result retry). `launchRetryBaseMs: 0` disables the mechanism (tests, and
   callers that want spawn errors to fail fast). Retries surface as
   `SingleResult.launchRetries` plus a stderr trail line.

2. **Bounded dead-letter capture, not unbounded logging.** Malformed JSONL
   lines are captured on `SingleResult.malformedOutput` as
   `"line N: <content>"` (1-based offset), capped at 20 entries with each
   line clipped to 200 chars — same discipline as the Bug 2/Bug 7 stderr
   caps. The pre-existing single stderr summary line is unchanged; a second
   bounded capture line joins it. Chain propagation needs no mechanism:
   malformed lines never enter `result.messages`, and chain mode forwards
   only `getFinalOutput(messages)`.

3. **Chain breaker: configurable threshold, conservative default.**
   `chainFailureThreshold` (schema 1–10, **default 1**) is the number of
   _consecutive_ failed steps that opens the breaker. Default 1 preserves
   the historical stop-at-first-failure semantics — per-step `retries` plus
   tier fallback already cover transient step failures, so defaulting to 2
   would change dispatch behavior more than warranted as a silent default.
   At 2+, a tolerated failure continues the chain from the last GOOD step's
   output (`{previous}` never carries a failure forward); the failure count
   resets on any success. When the breaker trips, untouched steps are
   appended to `details.results` with `stopReason:
"skipped_due_to_open_circuit"` (instead of silently vanishing) and
   `details.circuitBreaker` records `{threshold, consecutiveFailures,
stoppedAtStep, skippedSteps}`.

## Consequences

### Positive

- A transient launch failure (port conflict, OOM kill at spawn, fork
  exhaustion) no longer fails a dispatch that would have succeeded 1–4 s
  later — in every mode, without opting in per step.
- Operators can see _what_ malformed output dropped, with line offsets to
  correlate against a spill artifact, not just how much.
- Chain failures no longer hide the tail of the pipeline: every skipped step
  is visible in results, and the trip is machine-readable in details.
- All three mechanisms are bounded (3 relaunches ≈ ≤7 s added latency; 20 ×
  200 chars capture; threshold ≤ 10) and compose with existing retry/tier
  behavior rather than replacing it.

### Negative

- A _legitimate_ fast failure — an agent that exits non-zero inside 100 ms
  with no output — is retried up to 3 times, costing up to ~7 s and 3 extra
  spawns. The window is deliberately the issue's own spec; widening it
  trades wasted spawns for missed retries.
- Permanent spawn errors (e.g. ENOENT for a missing `pi` binary) are also
  retried before failing; bounded, but adds ~7 s to an inevitably failed
  dispatch. `launchRetryBaseMs: 0` opts out.
- Launch retries are runner-internal: `attempts` (the runWithRetries
  counter) does not include them; `launchRetries` is the separate,
  mode-independent trail.
- At the default threshold the breaker is pure observability — the tolerance
  the issue described only exists when callers pass ≥ 2.

### Alternatives considered

- **Dispatcher-level launch retry** (rejected): would duplicate
  runWithRetries machinery per mode; the runner owns spawn and is already
  spawnFn-injectable for tests.
- **Default threshold 2** (rejected as default, available opt-in): tolerating
  an unretried failed step buys poisoned-`{previous}` risk the current
  retry/fallback stack already handles; changing default dispatch semantics
  silently is worse than asking callers to opt in.
- **Unbounded malformed-line logging** (rejected): per-line logging is
  itself unbounded; captured arrays with caps keep diagnosis possible
  without the OOM path Bug 2/Bug 7 closed.
