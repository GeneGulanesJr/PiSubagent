import type { SubagentParams, SubagentDetails, Mode, AgentConfig } from '../types.js';

/**
 * Detect which dispatch mode the caller is asking for. Exactly one of
 * `{agent, task}` / `{tasks: [...]}` / `{chain: [...]}` must be present —
 * anything else (none, or a mix) returns `'invalid'`.
 */
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

/**
 * User-facing error payload returned when `detectMode` resolves to
 * `'invalid'`. The message lists the agents that *were* available so the
 * caller can correct the typo or pick a valid mode.
 */
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
