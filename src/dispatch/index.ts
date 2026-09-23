/**
 * Public surface of the dispatch package. This module is what `src/index.ts`
 * and the dispatch-related tests import from. Keep this in sync with the
 * legacy single-file `src/dispatch.ts` public API — no behavior changes,
 * only a fan-out into the per-mode and helper modules.
 */

// Mode detection + invalid-params error payload.
export { detectMode, buildInvalidParamsError } from './detect-mode.js';

// Orchestrator + shared types.
export { execute, selectRunner } from './execute.js';
export type { DispatchContext, ToolResultLike } from './types.js';

// Per-mode runners (kept as named exports so callers can target a mode
// directly without going through `execute`).
export { runSingle } from './run-single.js';
export { runParallel } from './run-parallel.js';
export { runChain } from './run-chain.js';

// Capacity + throttle constants.
export { MAX_PARALLEL_TASKS, MAX_CONCURRENCY, PER_TASK_OUTPUT_CAP } from './limits.js';
export { PROGRESS_THROTTLE_MS, createProgressEmitter } from './progress.js';
