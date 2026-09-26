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

export { baseDetails, parentDefaults, stubResult };

/** Hard cap on retries regardless of what the schema/caller passes. */
const MAX_RETRIES = 3;

/**
 * Run once, retrying failed results up to `retries` times. A user abort
 * (ctx.signal already aborted) is never retried. The returned result
 * carries `attempts` when more than one attempt was made. No backoff
 * delay in v1 — retries are immediate.
 */
export async function runWithRetries(
  runner: AgentRunner,
  input: AgentRunInput,
  ctx: DispatchContext,
  retries: number | undefined,
  onPartial?: (partial: SingleResult) => void,
): Promise<SingleResult> {
  const maxAttempts = 1 + Math.max(0, Math.min(retries ?? 0, MAX_RETRIES));
  let result = await runner.run(input, ctx.signal, onPartial);
  let attempt = 1;
  while (isFailedResult(result) && attempt < maxAttempts && !ctx.signal?.aborted) {
    attempt += 1;
    result = await runner.run(input, ctx.signal, onPartial);
  }
  return attempt > 1 ? { ...result, attempts: attempt } : result;
}
