export type JsonlEvent = Record<string, unknown> & { type?: string };

/**
 * Parse newline-delimited JSON from a buffered stream chunk.
 * Malformed and blank lines are skipped silently. Callers that need to
 * observe malformed drops should track them themselves (see
 * SubprocessRunner.run, which surfaces a single stderr summary at end).
 *
 * Return type is `Iterable<JsonlEvent>` (not `IterableIterator`) so callers
 * can use `for...of` / spread syntax without depending on the iterator's
 * internal `.next()` contract — the function is a generator, so it
 * trivially satisfies Iterable at runtime.
 */
export function* parseJsonlEvents(stream: string): Iterable<JsonlEvent> {
  for (const line of stream.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as JsonlEvent;
    } catch {
      // skip malformed lines
    }
  }
}
