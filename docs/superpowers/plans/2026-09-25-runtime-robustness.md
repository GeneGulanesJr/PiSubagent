# Runtime Robustness — v0.2.0 Feature Plan

Date: 2026-09-25 · Branch: `feat/runtime-robustness` · Mode: Sequential (subagent per task)

Baseline: `15b7886` on master. 202/202 tests, tsc clean, eslint 0 errors (10 pre-existing warnings).

Version target: **0.2.0** (minor — new dispatch params; `[Unreleased]` already holds the
dynamic thinking-level feature, so a 0.1.6 patch cut would mis-version it).

Shared file surface (`src/types.ts`, `src/index.ts`, `src/dispatch/*`, `src/runner/subprocess/runner.ts`)
→ **never dispatch two implementers concurrently** (skill red flag + prior 429 on parallel workers).

## Tasks

### Task 1 — Per-dispatch `timeoutMs`

- `timeoutMs?: number` on single params, `TaskItem`, `ChainItem` (mirror `thinkingLevel` placement).
- Add to `AgentRunInput`; `SubprocessRunner.run` honors per-run override over constructor `runTimeoutMs`.
- On expiry: reuse kill-abort path (SIGTERM → SIGKILL 5s), set `SingleResult.timedOut: true`.
- `isFailedResult()` counts timeouts as failures.
- Resolution: per-dispatch → runner constructor default → none.
- Tests: runner-level (fake timers / injected spawn), dispatch pass-through, schema acceptance.

### Task 2 — Retry policy `retries`

- `retries?: number` (0–3, default 0) on single params, `TaskItem`, `ChainItem`.
- Retry loop in `run-single` / `run-parallel` / `run-chain` around `runner.run`.
- Retry when `isFailedResult()` **except** user abort (signal already cancelled → never retried).
- Final result after last attempt is what's reported; progress emits attempt number.
- Tests: retry-then-succeed, all-attempts-fail, abort-not-retried, parallel/chain integration.

### Task 3 — Artifact spill-over

- When stdout would exceed `MAX_BUFFER_BYTES` (1 MB): stream overflow to a temp file
  instead of dropping bytes.
- `SingleResult.outputFile?: string` set when spill occurred; output text keeps truncated
  preview + explicit spill notice (extends ADR-0002 truncate philosophy).
- Cleanup on abort/error consistent with existing tmp-prompt-file handling.
- Tests: spill path via injected spawn, no-spill unchanged, cleanup on error.

### Task 4 — Usage rollups

- `SubagentDetails` gains aggregate usage for parallel/chain: sum of per-run `UsageStats`.
- Progress emitter reports running totals.
- Tests: parallel + chain aggregation math, single unchanged.

### Task 5 — Structured output `outputSchema`

- Optional `outputSchema?: object` (JSON Schema) on single params only (v1).
- Runner appends schema instruction to prompt; parses child JSON output;
  validates (TypeBox or light validator); `SingleResult.data?: unknown` on success.
- Invalid JSON/schema → `timedOut`-style explicit failure flag, not silent null.
- Tests: valid parse, invalid JSON, schema mismatch, no-schema passthrough.

### Task 6 — Session resume (research-gated)

- Investigate pi CLI session flags (`--no-session` currently hardcoded in `buildArgs`).
- If resume is cleanly supportable: `SingleResult.sessionId`, `resume?: string` param.
- Else: deliver `docs/adr/0004-session-resume.md` design doc; do not force it.

### Task 7 — Release consolidation

- CHANGELOG `[Unreleased]` entries for Tasks 1–6; README param tables updated.
- Bump `package.json` → `0.2.0`. Full `npm run verify`. Reviewer pass over cumulative diff.

## Review protocol (per task)

1. Worker returns DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT.
2. Orchestrator spec review: only task-scoped files touched; diff vs task text.
3. Quality review: `npm run verify` green, no drive-by refactors.
4. Orchestrator commits with `feat(<scope>): ...`.
