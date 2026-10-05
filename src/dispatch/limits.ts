/**
 * Dispatch capacity constants. Kept in a dedicated module so both the
 * orchestrator (`execute`) and the per-mode runners can import them without
 * pulling in unrelated code.
 *
 * Spec: docs/superpowers/specs/2026-09-08-pisubagent-design.md § Limits.
 */

/** Hard cap on parallel tasks[] accepted in a single dispatch. */
export const MAX_PARALLEL_TASKS = 8;

/** Per-batch concurrency window — at most N runs in flight at any moment. */
export const MAX_CONCURRENCY = 4;

/**
 * Per-task output cap (bytes). Applied to:
 *   - each parallel summary body before joining into content[0].text
 *   - each chain step's final output before substituting into {previous}
 *
 * The full untruncated output is still preserved verbatim in
 * details.results[i].messages — only the joined text the parent model sees
 * is capped.
 */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Soft delegation-policy threshold (ADR-0006, docs/delegation-policy.md).
 * Parallel dispatches with more than this many tasks are still allowed (up to
 * MAX_PARALLEL_TASKS) but runParallel appends a one-line, non-blocking policy
 * note to the parent-facing text, nudging toward the "prefer 0–1 subagents"
 * guideline. Guidance, not a cap — it never rejects a dispatch or flips
 * isError.
 */
export const POLICY_PARALLEL_WARN = 2;
