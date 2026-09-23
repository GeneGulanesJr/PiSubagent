import { spawn as defaultSpawn } from 'node:child_process';
import type { AgentRunner } from '../runner/runner.js';
import { SubprocessRunner } from '../runner/subprocess/index.js';
import { confirmProjectAgentsIfNeeded } from '../security.js';
import type { SubagentParams, AgentConfig } from '../types.js';
import type { DispatchContext, ToolResultLike } from './types.js';
import { detectMode, buildInvalidParamsError } from './detect-mode.js';
import { baseDetails } from './internal.js';
import { runSingle } from './run-single.js';
import { runParallel } from './run-parallel.js';
import { runChain } from './run-chain.js';

export type { DispatchContext, ToolResultLike } from './types.js';

/** v1 always dispatches via the subprocess backend. */
export function selectRunner(): AgentRunner {
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
