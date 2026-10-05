import {
  getFinalOutput,
  isFailedResult,
  getResultOutput,
  truncateParallelOutput,
} from '../output.js';
import { applyStructured, withStructuredInstruction } from '../structured.js';
import type { AgentRunner } from '../runner/runner.js';
import type { SubagentParams, AgentConfig, SingleResult, SubagentDetails } from '../types.js';
import { PER_TASK_OUTPUT_CAP } from './limits.js';
import { baseDetails, parentDefaults, runWithRetries, stubResult, sumUsage } from './internal.js';
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
  // Circuit breaker (issue #2): stop after N consecutive failed steps.
  // Default 1 = stop at the first failure (historical behavior). A
  // tolerated failure never feeds {previous} — the next step continues
  // from the last GOOD step's output.
  const breakerThreshold = Math.max(1, params.chainFailureThreshold ?? 1);
  const results: SingleResult[] = [];
  const emit = createProgressEmitter(ctx.onUpdate, ctx.progressIntervalMs);
  let previousOutput = '';
  let consecutiveFailures = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const resolvedTask = withStructuredInstruction(
      step.task.replace(/\{previous\}/g, previousOutput),
      step.outputSchema,
    );
    results.push(stubResult(lookup(step.agent), step.task));
    emit?.(snapshot('chain', base, results, steps.length));
    const result = await runWithRetries(
      runner,
      {
        agent: lookup(step.agent),
        task: step.task,
        cwd: step.cwd ?? ctx.cwd,
        resolvedTask,
        thinkingLevelOverride: step.thinkingLevel,
        modelOverride: step.model,
        tierOverride: step.tier,
        timeoutMs: step.timeoutMs,
        session: step.session,
        resume: step.resume,
        sessionDir: step.sessionDir,
        ...parentDefaults(ctx),
      },
      ctx,
      step.retries,
      (partial) => {
        results[i] = { ...partial, running: true };
        emit?.(snapshot('chain', base, results, steps.length));
      },
      { backoffMs: step.retryBackoffMs, retryOn: step.retryOn },
    );
    const settled = step.outputSchema
      ? { ...applyStructured(result, step.outputSchema), task: step.task }
      : result;
    results[i] = { ...settled, running: false };
    emit?.(snapshot('chain', base, results, steps.length));

    if (isFailedResult(result)) {
      consecutiveFailures += 1;
      if (consecutiveFailures < breakerThreshold) {
        // Tolerated: keep the last good output and continue.
        continue;
      }
      // Breaker open: report every untouched step as skipped instead of
      // letting them silently vanish from details.results.
      for (let j = i + 1; j < steps.length; j++) {
        results.push({
          ...stubResult(lookup(steps[j].agent), steps[j].task),
          running: false,
          stopReason: 'skipped_due_to_open_circuit',
        });
      }
      emit?.(snapshot('chain', base, results, steps.length));
      const skippedSteps = steps.length - i - 1;
      const details: SubagentDetails = {
        ...base,
        results,
        usage: sumUsage(results),
        circuitBreaker: {
          threshold: breakerThreshold,
          consecutiveFailures,
          stoppedAtStep: i + 1,
          skippedSteps,
        },
      };
      return {
        content: [
          {
            type: 'text',
            text:
              `Chain stopped at step ${i + 1} (${step.agent}) after ${consecutiveFailures} consecutive failure(s): ${getResultOutput(result)}` +
              (skippedSteps > 0
                ? `. Remaining ${skippedSteps} step(s) skipped_due_to_open_circuit.`
                : '.'),
          },
        ],
        details,
        isError: true,
      };
    }
    consecutiveFailures = 0;
    previousOutput = truncateParallelOutput(getFinalOutput(result.messages), PER_TASK_OUTPUT_CAP);
  }

  const final = results[results.length - 1];
  return {
    content: [{ type: 'text', text: getFinalOutput(final.messages) || '(no output)' }],
    details: { ...base, results, usage: sumUsage(results) },
    isError: false,
  };
}
