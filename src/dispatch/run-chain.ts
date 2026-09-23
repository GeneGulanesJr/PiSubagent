import {
  getFinalOutput,
  isFailedResult,
  getResultOutput,
  truncateParallelOutput,
} from '../output.js';
import type { AgentRunner } from '../runner/runner.js';
import type { SubagentParams, AgentConfig, SingleResult } from '../types.js';
import { PER_TASK_OUTPUT_CAP } from './limits.js';
import { baseDetails, parentDefaults, stubResult } from './internal.js';
import { createProgressEmitter, snapshot } from './progress.js';
import type { DispatchContext, ToolResultLike } from './types.js';

export async function runChain(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  _agents: AgentConfig[],
  lookup: (name: string) => AgentConfig,
): Promise<ToolResultLike> {
  const steps = params.chain!;
  const base = baseDetails('chain', params, null);
  const results: SingleResult[] = [];
  const emit = createProgressEmitter(ctx.onUpdate, ctx.progressIntervalMs);
  let previousOutput = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const resolvedTask = step.task.replace(/\{previous\}/g, previousOutput);
    results.push(stubResult(lookup(step.agent), step.task));
    emit?.(snapshot('chain', base, results, steps.length));
    const result = await runner.run(
      {
        agent: lookup(step.agent),
        task: step.task,
        cwd: step.cwd ?? ctx.cwd,
        resolvedTask,
        ...parentDefaults(ctx),
      },
      ctx.signal,
      (partial) => {
        results[i] = { ...partial, running: true };
        emit?.(snapshot('chain', base, results, steps.length));
      },
    );
    results[i] = { ...result, running: false };
    emit?.(snapshot('chain', base, results, steps.length));

    if (isFailedResult(result)) {
      return {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}`,
          },
        ],
        details: { ...base, results },
        isError: true,
      };
    }
    previousOutput = truncateParallelOutput(getFinalOutput(result.messages), PER_TASK_OUTPUT_CAP);
  }

  const final = results[results.length - 1];
  return {
    content: [{ type: 'text', text: getFinalOutput(final.messages) || '(no output)' }],
    details: { ...base, results },
    isError: false,
  };
}
