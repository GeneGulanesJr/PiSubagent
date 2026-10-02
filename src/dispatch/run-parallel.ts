import { isFailedResult, getResultOutput, truncateParallelOutput } from '../output.js';
import { applyStructured, withStructuredInstruction } from '../structured.js';
import type { AgentRunner } from '../runner/runner.js';
import type { SubagentParams, AgentConfig, SingleResult } from '../types.js';
import { MAX_PARALLEL_TASKS, PER_TASK_OUTPUT_CAP } from './limits.js';
import { baseDetails, parentDefaults, runWithRetries, stubResult, sumUsage } from './internal.js';
import { createProgressEmitter, snapshot } from './progress.js';
import { providerForRun, runWithCaps } from './schedule.js';
import type { DispatchContext, ToolResultLike } from './types.js';

export async function runParallel(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  _agents: AgentConfig[],
  lookup: (name: string) => AgentConfig,
): Promise<ToolResultLike> {
  const tasks = params.tasks!;
  if (tasks.length > MAX_PARALLEL_TASKS) {
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: { ...baseDetails('parallel', params, null), results: [] },
      isError: true,
    };
  }
  const base = baseDetails('parallel', params, null);
  const results: SingleResult[] = tasks.map((t) => stubResult(lookup(t.agent), t.task));
  const emit = createProgressEmitter(ctx.onUpdate, ctx.progressIntervalMs);
  emit?.(snapshot('parallel', base, results, tasks.length));
  // Concurrency scheduling. Originally a per-batch cap of MAX_CONCURRENCY
  // (ADR-0001); now a sliding window that also enforces per-provider caps
  // (provider plan limits — z.ai 2, MiniMax 3; ADR-0005). The batch loop
  // could not express per-provider slots: one batch of 4 same-provider
  // tasks would blow a cap of 2. A task whose provider is at its cap does
  // not block later tasks with free slots. Result order and progress
  // emissions are identical to the batched version.
  const parent = parentDefaults(ctx);
  const providers = tasks.map((t) =>
    providerForRun(
      lookup(t.agent),
      { modelOverride: t.model, tierOverride: t.tier },
      parent.parentModel,
    ),
  );
  await runWithCaps(providers, (i) => {
    const t = tasks[i]!;
    return runWithRetries(
      runner,
      {
        agent: lookup(t.agent),
        task: withStructuredInstruction(t.task, t.outputSchema),
        cwd: t.cwd ?? ctx.cwd,
        thinkingLevelOverride: t.thinkingLevel,
        modelOverride: t.model,
        tierOverride: t.tier,
        timeoutMs: t.timeoutMs,
        session: t.session,
        resume: t.resume,
        sessionDir: t.sessionDir,
        ...parent,
      },
      ctx,
      t.retries,
      (partial) => {
        results[i] = { ...partial, running: true };
        emit?.(snapshot('parallel', base, results, tasks.length));
      },
      { backoffMs: t.retryBackoffMs, retryOn: t.retryOn },
    ).then((final) => {
      const settled = t.outputSchema
        ? { ...applyStructured(final, t.outputSchema), task: t.task }
        : final;
      results[i] = { ...settled, running: false };
      emit?.(snapshot('parallel', base, results, tasks.length));
    });
  });
  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const summaries = results.map((r) => {
    const status = isFailedResult(r) ? 'failed' : 'completed';
    // Cap each per-agent summary body at PER_TASK_OUTPUT_CAP bytes so a single
    // chatty agent can't flood the parent's context with multi-MB content text.
    // The full output is still preserved verbatim in details.results[i].messages
    // — only the joined `content[0].text` that the parent model sees is capped.
    // Spec: docs/superpowers/specs/2026-09-08-pisubagent-design.md § Limits.
    const body = truncateParallelOutput(getResultOutput(r), PER_TASK_OUTPUT_CAP);
    return `### [${r.agent}] ${status}\n\n${body}`;
  });
  return {
    content: [
      {
        type: 'text',
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`,
      },
    ],
    details: { ...base, results, usage: sumUsage(results) },
    isError: successCount < results.length,
  };
}
