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
