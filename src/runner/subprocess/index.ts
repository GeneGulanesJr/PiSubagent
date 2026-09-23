/**
 * Public surface of the subprocess runner package. This module is what
 * `src/dispatch/execute.ts`, `src/runner/runner.ts` consumers, and the
 * subprocess tests import from. Keep this in sync with the legacy
 * single-file `src/runner/subprocess.ts` public API — no behavior
 * changes, only a fan-out into the helper modules.
 */

export { resolvePiInvocation, type PiInvocation } from './invocation.js';
export { writePromptFile } from './prompt-file.js';
export { killOnAbort } from './kill-abort.js';
export { parseJsonlEvents, type JsonlEvent } from './jsonl.js';
export { SubprocessRunner, type SubprocessRunnerOptions } from './runner.js';
