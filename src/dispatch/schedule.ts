import { MAX_CONCURRENCY } from './limits.js';
import { loadProviderLimits, providerOfModel } from '../provider-limits.js';
import { resolveRunModel } from '../tier.js';
import type { AgentConfig } from '../types.js';

/**
 * Provider-aware scheduling for parallel dispatch.
 *
 * The per-batch window (MAX_CONCURRENCY, ADR-0001) bounds total in-flight
 * runs, but provider plans also cap concurrent requests per account — z.ai
 * allows 2, MiniMax 3 (see src/provider-limits.ts). Static batches cannot
 * express that: one batch of 4 same-provider tasks would blow a cap of 2.
 * ADR-0005 replaces the batch loop with this sliding window that starts a
 * task only when both the total window and the task's provider slot allow.
 */

/**
 * Provider whose plan a run counts against: the prefix of the run's resolved
 * model id (dispatch model override → tier → agent frontmatter → parent
 * inheritance). Undefined = no attributable provider (bare model id or no
 * model anywhere) → the run is uncapped (still bounded by MAX_CONCURRENCY).
 */
export function providerForRun(
  agent: Pick<AgentConfig, 'model' | 'tier'>,
  overrides: { modelOverride?: string; tierOverride?: ReturnType<typeof resolveRunModel>['tier'] },
  parentModel?: string,
): string | undefined {
  const resolved = resolveRunModel(agent, overrides);
  return providerOfModel(resolved.model ?? parentModel);
}

export interface ScheduleOptions {
  /** Total in-flight window. Default MAX_CONCURRENCY. */
  maxTotal?: number;
  /** Provider → cap mapping. Default loadProviderLimits(). */
  limits?: Record<string, number>;
}

/**
 * Run `start(i)` for every index, keeping at most `maxTotal` tasks in flight
 * and at most `limits[provider]` in flight per provider. A task whose
 * provider slot is full does not block later tasks with free slots
 * (mixed-provider batches keep flowing); strict order is preserved for
 * *starting* eligible tasks.
 *
 * Failure semantics: `start` rejections are not fail-fast (Promise.all
 * throws while sibling tasks keep running detached). All in-flight tasks
 * settle, then the first rejection rethrows — same "the dispatch failed"
 * contract for callers, without orphaned background promises.
 */
export async function runWithCaps(
  providers: Array<string | undefined>,
  start: (index: number) => Promise<void>,
  opts: ScheduleOptions = {},
): Promise<void> {
  const maxTotal = opts.maxTotal ?? MAX_CONCURRENCY;
  const limits = opts.limits ?? loadProviderLimits();
  const capOf = (p: string | undefined): number | undefined =>
    p === undefined ? undefined : limits[p];

  const pending = providers.map((_, i) => i);
  const inFlight = new Map<Promise<void>, string | undefined>();
  const counts = new Map<string, number>();
  let firstError: { error: unknown } | undefined;

  while (pending.length > 0 || inFlight.size > 0) {
    for (let k = 0; k < pending.length && inFlight.size < maxTotal;) {
      const i = pending[k]!;
      const provider = providers[i];
      const cap = capOf(provider);
      if (cap !== undefined && (counts.get(provider!) ?? 0) >= cap) {
        k += 1; // provider slot full — a later task with a free slot may start
        continue;
      }
      pending.splice(k, 1);
      if (provider !== undefined) counts.set(provider, (counts.get(provider) ?? 0) + 1);
      const task = start(i).catch((error: unknown) => {
        firstError ??= { error };
      });
      // `tracked` settles only after the finally callback runs, so when the
      // race below resolves the maps are already consistent for the pump.
      const tracked = task.finally(() => {
        inFlight.delete(tracked);
        if (provider !== undefined) {
          counts.set(provider, Math.max(0, (counts.get(provider) ?? 1) - 1));
        }
      });
      inFlight.set(tracked, provider);
    }
    if (inFlight.size === 0) break; // defensive: unreachable while caps ≥ 1
    await Promise.race(inFlight.keys());
  }

  if (firstError) throw firstError.error;
}
