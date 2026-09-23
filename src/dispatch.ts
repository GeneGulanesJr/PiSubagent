/**
 * Backwards-compatible shim. The dispatch package lives in `src/dispatch/*`
 * (a directory with an `index.ts`); this file preserves the legacy
 * `import {...} from './dispatch.js'` path used by tests and any other
 * external consumer that depended on the old single-file layout.
 *
 * No behavior lives here — all symbols are re-exported from the new home.
 */
export * from './dispatch/index.js';
