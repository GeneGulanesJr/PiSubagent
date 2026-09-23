import { spawn as defaultSpawn } from 'node:child_process';
import type { AgentToolResult, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  SubagentParams,
  SubagentDetails,
  Mode,
  AgentConfig,
  SingleResult,
  UsageStats,
  OnUpdateCallback,
} from './types.js';
import type { AgentRunner } from './runner/runner.js';
import { confirmProjectAgentsIfNeeded } from './security.js';
import { SubprocessRunner } from './runner/subprocess.js';
import {
  getFinalOutput,
  isFailedResult,
  getResultOutput,
  formatTokens,
  truncateParallelOutput,
} from './output.js';

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export function detectMode(params: SubagentParams): Mode | 'invalid' {
  const single = Boolean(params.agent && params.task);
  const parallel = (params.tasks?.length ?? 0) > 0;
  const chain = (params.chain?.length ?? 0) > 0;
  const count = Number(single) + Number(parallel) + Number(chain);
  if (count !== 1) return 'invalid';
  if (single) return 'single';
  if (parallel) return 'parallel';
  return 'chain';
}

export function buildInvalidParamsError(agents: AgentConfig[]): {
  content: Array<{ type: 'text'; text: string }>;
  details: SubagentDetails;
  isError: true;
} {
  const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none';
  return {
    content: [
      {
        type: 'text',
        text: `Invalid parameters. Provide exactly one mode: {agent, task} OR {tasks: [...]} OR {chain: [...]}. Available agents: ${available}`,
      },
    ],
    details: { mode: 'single', agentScope: 'user', projectAgentsDir: null, results: [] },
    isError: true,
  };
}

export interface DispatchContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  ui: { confirm: (title: string, message: string) => Promise<boolean> };
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  /** Abort signal from the tool call (Esc); forwarded to every runner.run. */
  signal?: AbortSignal;
  /** Live-progress sink from the tool API; receives throttled running snapshots. */
  onUpdate?: OnUpdateCallback;
  /** Throttle window for progress emissions. Default 250ms; 0 disables coalescing. */
  progressIntervalMs?: number;
}

export interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}

function baseDetails(
  mode: Mode,
  params: SubagentParams,
  projectAgentsDir: string | null,
): Omit<SubagentDetails, 'results'> {
  return { mode, agentScope: params.agentScope ?? 'user', projectAgentsDir };
}

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

function progressLine(mode: Mode, results: readonly SingleResult[], total: number): string {
  const done = results.filter((r) => !r.running).length;
  if (mode === 'single') {
    const r = results[0];
    if (!r) return 'Running…';
    return r.running
      ? `${r.agent}: running… (${r.messages.length} msg, ↓${formatTokens(r.usage.output)} tok)`
      : `${r.agent}: done`;
  }
  if (mode === 'parallel') {
    return `Running ${total} subagent${total === 1 ? '' : 's'}… (${done}/${total} done)`;
  }
  const current = results[results.length - 1];
  return `Step ${results.length}/${total}: ${current ? current.agent : '?'} running…`;
}

type ProgressPayload = AgentToolResult<SubagentDetails>;

function snapshot(
  mode: Mode,
  base: Omit<SubagentDetails, 'results'>,
  results: SingleResult[],
  total: number,
): ProgressPayload {
  return {
    content: [{ type: 'text', text: progressLine(mode, results, total) }],
    details: { ...base, results: results.map((r) => ({ ...r })) },
  };
}

export const PROGRESS_THROTTLE_MS = 250;

/**
 * Leading+trailing throttle over the tool-level onUpdate sink. First call fires
 * immediately; calls inside the window coalesce into one trailing emit carrying
 * the latest payload. Undefined sink → undefined emitter (noop path).
 */
export function createProgressEmitter(
  onUpdate: OnUpdateCallback | undefined,
  intervalMs: number = PROGRESS_THROTTLE_MS,
): ((payload: ProgressPayload) => void) | undefined {
  if (!onUpdate) return undefined;
  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: ProgressPayload | undefined;
  return (payload) => {
    latest = payload;
    const now = Date.now();
    if (now - lastEmit >= intervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastEmit = now;
      onUpdate(payload);
      return;
    }
    if (timer) return;
    timer = setTimeout(
      () => {
        timer = null;
        lastEmit = Date.now();
        if (latest) onUpdate(latest);
      },
      intervalMs - (now - lastEmit),
    );
  };
}

export function selectRunner(): AgentRunner {
  // v1: always subprocess. v2 swaps via config gating (see spec § AgentRunner).
  return new SubprocessRunner({ spawnFn: defaultSpawn });
}

/**
 * Mode orchestrator. `agents` is the resolved discovery list (from index.ts),
 * already filtered to the agents this dispatch needs. `runnerOverride` lets
 * tests inject a SubprocessRunner with a fake spawn (ESM bindings can't be
 * monkey-patched).
 */
export async function execute(
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
  runnerOverride?: AgentRunner,
): Promise<ToolResultLike> {
  const mode = detectMode(params);
  if (mode === 'invalid') return buildInvalidParamsError(agents);

  const decision = await confirmProjectAgentsIfNeeded(params, agents, ctx);
  if (!decision.continue) {
    // Use the detected mode so `details.mode` reflects what the user invoked,
    // not a placeholder. Before this fix, a parallel or chain call that was
    // denied at the confirmation gate would report `mode: "single"` to
    // consumers (rendering, logging, automation), lying about the request.
    return {
      content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
      details: { ...baseDetails(mode, params, null), results: [] },
      isError: true,
    };
  }

  const runner = runnerOverride ?? selectRunner();
  const lookup = (name: string): AgentConfig =>
    agents.find((a) => a.name === name) ?? {
      name,
      description: '',
      systemPrompt: '',
      source: 'bundled',
      filePath: '',
    };

  if (mode === 'single') return runSingle(runner, params, ctx, agents, lookup);
  if (mode === 'parallel') return runParallel(runner, params, ctx, agents, lookup);
  return runChain(runner, params, ctx, agents, lookup);
}

export async function runSingle(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
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

export async function runParallel(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
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
        return runner
          .run(
            {
              agent: lookup(t.agent),
              task: t.task,
              cwd: t.cwd ?? ctx.cwd,
              ...parentDefaults(ctx),
            },
            ctx.signal,
            (partial) => {
              results[i] = { ...partial, running: true };
              emit?.(snapshot('parallel', base, results, tasks.length));
            },
          )
          .then((final) => {
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
    details: { ...base, results },
    isError: successCount < results.length,
  };
}

export async function runChain(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
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
