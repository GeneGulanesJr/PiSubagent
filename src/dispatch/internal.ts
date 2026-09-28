import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  SubagentParams,
  SubagentDetails,
  Mode,
  AgentConfig,
  SingleResult,
  UsageStats,
} from '../types.js';
import type { DispatchContext } from './types.js';
import type { AgentRunner, AgentRunInput } from '../runner/runner.js';
import { isFailedResult } from '../output.js';
import { resolveRunModel } from '../tier.js';

/**
 * Internal helpers shared by the per-mode runners (`run-single`,
 * `run-parallel`, `run-chain`) and the orchestrator (`execute`).
 *
 * Kept in a single module — splitting them further would just create
 * cross-import noise without buying clarity. None of these are re-exported
 * from `dispatch/index.ts`; they're an internal surface of the dispatch
 * package.
 */

/** SubagentDetails minus the `results` array — set once per dispatch. */
function baseDetails(
  mode: Mode,
  params: SubagentParams,
  projectAgentsDir: string | null,
): Omit<SubagentDetails, 'results'> {
  return { mode, agentScope: params.agentScope ?? 'user', projectAgentsDir };
}

/** Inheritable model/thinking from the dispatching session, spread into AgentRunInput. */
function parentDefaults(ctx: DispatchContext): {
  parentModel?: string;
  parentThinkingLevel?: ThinkingLevel;
} {
  return {
    parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    parentThinkingLevel: ctx.thinkingLevel,
  };
}

const ZERO_USAGE: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

/**
 * Initial `running: true` placeholder inserted into the live results array
 * before the runner is invoked. The runner replaces it (or merges into it)
 * as partial updates arrive.
 */
function stubResult(agentCfg: AgentConfig, task: string): SingleResult {
  return {
    agent: agentCfg.name,
    agentSource: agentCfg.source === 'bundled' ? 'user' : agentCfg.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { ...ZERO_USAGE },
    running: true,
  };
}

/**
 * Aggregate usage across results. Counters (input/output/cache/cacheWrite/
 * cost/turns) sum; `contextTokens` is a gauge (peak context), so it takes
 * the max rather than a misleading sum.
 */
export function sumUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.contextTokens = Math.max(total.contextTokens, r.usage.contextTokens);
    total.turns += r.usage.turns;
  }
  return total;
}

export { baseDetails, parentDefaults, stubResult };

/** Hard cap on retries regardless of what the schema/caller passes. */
const MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Base backoff delay in ms; exponential with 30s cap. 0/undefined = immediate. */
  backoffMs?: number;
  /** Failure classes eligible for retry; undefined = any failed result. */
  retryOn?: Array<'error' | 'timeout'>;
}

/**
 * Run once, retrying failed results up to `retries` times. A user abort
 * (ctx.signal already aborted) is never retried. The returned result
 * carries `attempts` when more than one attempt was made.
 *
 * `opts.backoffMs` adds an exponential delay before each retry: retry index
 * i (1st, 2nd, 3rd retry) waits backoffMs × 2^(i-1) — base, 2×, 4× — capped
 * at 30s. `opts.retryOn` restricts which failure classes retry —
 * a timed-out result classifies as 'timeout', every other failure as
 * 'error'; aborts are never retried regardless of the filter.
 *
 * Tier fallback: when the final result (after retries) is still failed AND
 * the run was tier-routed to a non-parent model, the run is attempted once
 * more on the parent model. Offloading is best-effort — a quota-exhausted
 * or unavailable tier model should degrade to the parent, not fail the
 * dispatch. Explicit `model:` pins never fall back (the pin is deliberate).
 */
export async function runWithRetries(
  runner: AgentRunner,
  input: AgentRunInput,
  ctx: DispatchContext,
  retries: number | undefined,
  onPartial?: (partial: SingleResult) => void,
  opts?: RetryOptions,
): Promise<SingleResult> {
  const maxAttempts = 1 + Math.max(0, Math.min(retries ?? 0, MAX_RETRIES));
  let result = await runner.run(input, ctx.signal, onPartial);
  let attempt = 1;
  // Spend accumulates across attempts — discarding failed attempts' usage
  // would under-report true cost exactly when retries fire.
  const usage: UsageStats = { ...result.usage };
  while (isFailedResult(result) && attempt < maxAttempts && !ctx.signal?.aborted) {
    // Failure-class filter: when retryOn is set, only listed classes retry.
    // A timed-out result classifies as 'timeout' (timedOut flag or stopReason);
    // every other failure classifies as 'error'. Aborts never reach here.
    if (opts?.retryOn) {
      const failureClass =
        result.timedOut === true || result.stopReason === 'timeout' ? 'timeout' : 'error';
      if (!opts.retryOn.includes(failureClass)) break;
    }
    if (opts?.backoffMs && opts.backoffMs > 0) {
      const delay = Math.min(opts.backoffMs * 2 ** (attempt - 1), 30_000);
      await sleep(delay);
      if (ctx.signal?.aborted) break;
    }
    attempt += 1;
    result = await runner.run(input, ctx.signal, onPartial);
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheWrite += result.usage.cacheWrite;
    usage.cost += result.usage.cost;
    usage.contextTokens = Math.max(usage.contextTokens, result.usage.contextTokens);
    usage.turns += result.usage.turns;
  }

  // Tier fallback: one extra attempt on the parent model for tier-routed
  // runs that still failed. The fallback reuses the same session/resume
  // semantics (pi sessions tolerate a model switch mid-session).
  if (isFailedResult(result) && !ctx.signal?.aborted) {
    const resolved = resolveRunModel(input.agent, {
      modelOverride: input.modelOverride,
      tierOverride: input.tierOverride,
    });
    if (resolved.tier && input.parentModel && resolved.model !== input.parentModel) {
      const fallbackInput: AgentRunInput = {
        ...input,
        modelOverride: input.parentModel,
        tierOverride: undefined,
      };
      const fallback = await runner.run(fallbackInput, ctx.signal, onPartial);
      usage.input += fallback.usage.input;
      usage.output += fallback.usage.output;
      usage.cacheRead += fallback.usage.cacheRead;
      usage.cacheWrite += fallback.usage.cacheWrite;
      usage.cost += fallback.usage.cost;
      usage.contextTokens = Math.max(usage.contextTokens, fallback.usage.contextTokens);
      usage.turns += fallback.usage.turns;
      attempt += 1;
      if (!isFailedResult(fallback)) {
        fallback.stderr = appendStderrNote(
          fallback.stderr,
          `[tier fallback: ${resolved.tier} (${resolved.model}) failed — reran on parent model ${input.parentModel}]`,
        );
        return { ...fallback, attempts: attempt, usage, fellBackToParent: true };
      }
      // Fallback also failed — return it (fresher stderr, parent-model
      // context) with the fallback marker so the caller can see the route.
      return {
        ...fallback,
        attempts: attempt,
        usage,
        fellBackToParent: true,
        errorMessage:
          fallback.errorMessage || result.errorMessage || fallback.stderr || result.stderr,
      };
    }
  }

  return attempt > 1 ? { ...result, attempts: attempt, usage } : result;
}

/** Append a stderr note, respecting no impl-level cap here (runner caps its own). */
function appendStderrNote(stderr: string, note: string): string {
  return stderr ? `${stderr}\n${note}\n` : `${note}\n`;
}
