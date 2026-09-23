/**
 * Backwards-compatible shim. The subprocess runner lives in
 * `src/runner/subprocess/*` (a directory with an `index.ts`); this file
 * preserves the legacy `import {...} from '../runner/subprocess.js'` path
 * used by tests and any other external consumer that depended on the old
 * single-file layout.
 *
 * No behavior lives here — all symbols are re-exported from the new home.
 */
export * from './subprocess/index.js';
