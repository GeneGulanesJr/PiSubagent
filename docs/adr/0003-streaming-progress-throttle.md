# 0003. Streaming progress with per-agent latest message at 150ms throttle

## Status

Accepted (2026-09-23, commit `83c5ebf`)

## Context

The `onUpdate` snapshot pipeline was already wired up, but `progressLine` emitted only sparse counters ("Running N subagents… (M/N done)"). The parent UI felt static because nothing visibly changed for the user during multi-agent dispatches.

## Decision

- New shared helper `progressSnippet(messages)` in `src/output.ts` returns the latest assistant text part (whitespace-collapsed, truncated to 120 chars), or the most recent tool-call name as `→ toolName`, or `(starting…)` if no assistant output yet.
- `progressLine` rewritten to surface `progressSnippet` per running agent for single / parallel / chain modes.
- `renderMultiResult` partial mode surfaces the same per-agent text inline.
- `PROGRESS_THROTTLE_MS` reduced 250 → 150 (visibly faster updates without flooding).

## Consequences

### Positive

- Live "what is each agent doing" feedback during dispatches.
- Tool-call names show progress through bash/read/etc. without revealing arguments (compact, no argument-bloat).
- Test count: 109 → 111 (added regression tests in `dispatch-progress.test.ts` + `render.test.ts`).

### Negative

- Snippet truncation means the user doesn't see the full message content per agent until completion. Acceptable trade-off for the live update cadence.

### Alternatives considered

- **Per-message streaming** (sub-second): would require changes to SubprocessRunner's emit cadence. Not needed now — 150ms on `message_end` events is fine.
- **100ms or 200ms throttle**: 150ms was chosen for a balance — fast enough to feel live, slow enough that Pi's line-based rendering doesn't thrash.
- **Tool-call args inline**: rejected; args can be 1KB+, would blow the snippet budget.
