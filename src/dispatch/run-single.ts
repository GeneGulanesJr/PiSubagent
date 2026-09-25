import { getFinalOutput, isFailedResult } from '../output.js';
import type { AgentRunner } from '../runner/runner.js';
import type { SubagentParams, AgentConfig, SingleResult } from '../types.js';
import { baseDetails, parentDefaults, stubResult } from './internal.js';
import { createProgressEmitter, snapshot } from './progress.js';
import type { DispatchContext, ToolResultLike } from './types.js';

export async function runSingle(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  _agents: AgentConfig[],
  lookup: (name: string) => AgentConfig,
): Promise<ToolResultLike> {
  const agentCfg = lookup(params.agent!);
  const base = baseDetails('single', params, null);
  const results: SingleResult[] = [stubResult(agentCfg, params.task!)];
  const emit = createProgressEmitter(ctx.onUpdate, ctx.progressIntervalMs);
  emit?.(snapshot('single', base, results, 1));
  const result = await runner.run(
    {
      agent: agentCfg,
      task: params.task!,
      cwd: params.cwd ?? ctx.cwd,
      thinkingLevelOverride: params.thinkingLevel,
      ...parentDefaults(ctx),
    },
    ctx.signal,
    (partial) => {
      results[0] = { ...partial, running: true };
      emit?.(snapshot('single', base, results, 1));
    },
  );
  results[0] = { ...result, running: false };
  return {
    content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
    details: { ...base, results },
    isError: isFailedResult(result),
  };
}
