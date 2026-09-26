import { isFailedResult, getResultOutput, truncateParallelOutput } from '../output.js';
import type { AgentRunner } from '../runner/runner.js';
import type { SubagentParams, AgentConfig, SingleResult } from '../types.js';
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, PER_TASK_OUTPUT_CAP } from './limits.js';
import { baseDetails, parentDefaults, runWithRetries, stubResult, sumUsage } from './internal.js';
import { createProgressEmitter, snapshot } from './progress.js';
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
  // Per-batch concurrency cap. The design spec (docs/superpowers/specs/2026-09-08-pisubagent-design.md
  // § Limits) advertises MAX_CONCURRENCY = 4 as a per-batch window — at most N
  // runs in flight at any moment. Prior to this fix the entire tasks[] array
  // fired via bare Promise.all, which made the cap unenforced (API drift).
  // Implementation: chunk into batches of size MAX_CONCURRENCY, await each
  // batch's Promise.all before starting the next. Result order and progress
  // emissions are identical to the unbounded version.
  for (let batchStart = 0; batchStart < tasks.length; batchStart += MAX_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + MAX_CONCURRENCY, tasks.length);
    await Promise.all(
      tasks.slice(batchStart, batchEnd).map((t, j) => {
        const i = batchStart + j;
        return runWithRetries(
          runner,
          {
            agent: lookup(t.agent),
            task: t.task,
            cwd: t.cwd ?? ctx.cwd,
            thinkingLevelOverride: t.thinkingLevel,
            timeoutMs: t.timeoutMs,
            session: t.session,
            resume: t.resume,
            ...parentDefaults(ctx),
          },
          ctx,
          t.retries,
          (partial) => {
            results[i] = { ...partial, running: true };
            emit?.(snapshot('parallel', base, results, tasks.length));
          },
        ).then((final) => {
          results[i] = { ...final, running: false };
          emit?.(snapshot('parallel', base, results, tasks.length));
        });
      }),
    );
  }
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
