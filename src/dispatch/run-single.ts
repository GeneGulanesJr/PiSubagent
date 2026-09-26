import { getFinalOutput, isFailedResult } from '../output.js';
import { buildStructuredInstruction, applyStructured } from '../structured.js';
import type { AgentRunner } from '../runner/runner.js';
import type { SubagentParams, AgentConfig, SingleResult } from '../types.js';
import { baseDetails, parentDefaults, runWithRetries, stubResult } from './internal.js';
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
  const task = params.outputSchema
    ? `${params.task!}\n\n${buildStructuredInstruction(params.outputSchema)}`
    : params.task!;
  const emit = createProgressEmitter(ctx.onUpdate, ctx.progressIntervalMs);
  emit?.(snapshot('single', base, results, 1));
  const result = await runWithRetries(
    runner,
    {
      agent: agentCfg,
      task,
      cwd: params.cwd ?? ctx.cwd,
      thinkingLevelOverride: params.thinkingLevel,
      timeoutMs: params.timeoutMs,
      session: params.session,
      resume: params.resume,
      ...parentDefaults(ctx),
    },
    ctx,
    params.retries,
    (partial) => {
      results[0] = { ...partial, running: true };
      emit?.(snapshot('single', base, results, 1));
    },
  );
  const settled = params.outputSchema
    ? { ...applyStructured(result, params.outputSchema), task: params.task! }
    : result;
  results[0] = { ...settled, running: false };
  return {
    content: [{ type: 'text', text: getFinalOutput(settled.messages) || '(no output)' }],
    details: { ...base, results },
    isError: isFailedResult(result),
  };
}
