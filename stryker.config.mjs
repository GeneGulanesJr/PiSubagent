/** @type {import('@stryker-mutator/core').StrykerOptions} */
export default {
  testRunner: 'vitest',
  reporters: ['progress', 'clear-text', 'html'],
  coverageAnalysis: 'perTest',
  // Scope: mutate src/ but skip type files and the index.ts entry point.
  mutate: ['src/**/*.ts', '!src/**/types.ts', '!src/**/index.ts'],
  // Limit scope for the initial run so it's fast; expand later.
  timeoutMS: 60000,
  concurrency: 2,
};
