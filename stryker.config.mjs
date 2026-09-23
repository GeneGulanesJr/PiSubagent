/** @type {import('@stryker-mutator/core').StrykerOptions} */
export default {
  testRunner: 'vitest',
  reporters: ['progress', 'clear-text', 'html'],
  coverageAnalysis: 'perTest',
  // Scope focuses on the most-tested paths: dispatch (orchestration, runners,
  // progress streaming) and subprocess (CLI flag composition, JSONL parsing,
  // abort handling). The shim files at src/dispatch.ts and src/runner/subprocess.ts
  // are included alongside their directory contents. Excluded: output/render/
  // security/agents (mostly string formatting, low test signal), types.ts/index.ts
  // (no behavior to mutate), runner.ts (interface only), in-process.ts (stub).
  // Result: ~600 mutants instead of 1320, ~15 min runtime vs ~39 min.
  mutate: [
    // Core dispatch path (well-tested)
    'src/dispatch.ts',
    'src/dispatch/**/*.ts',
    // Subprocess runner (well-tested)
    'src/runner/subprocess.ts',
    'src/runner/subprocess/**/*.ts',
  ],
  // Limit scope for the initial run so it's fast; expand later.
  timeoutMS: 60000,
  concurrency: 2,
};
