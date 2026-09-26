import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Text } from '@earendil-works/pi-tui';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SubagentParams, SubagentDetails } from './types.js';
import { resolveBundledAgentsDir, discoverAgents, type AgentScope } from './agents.js';
import { execute, type DispatchContext, type ToolResultLike } from './dispatch/index.js';
import { renderCall, renderResult } from './render.js';

const THINKING_LEVEL_DESCRIPTION =
  "Reasoning effort for this dispatch. Overrides the agent's frontmatter thinkingLevel and the default (medium for model-pinned agents; parent's level when the agent inherits the model).";

const ThinkingLevelSchema = Type.Union(
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((l) => Type.Literal(l)),
  { description: THINKING_LEVEL_DESCRIPTION },
);

const TIMEOUT_MS_DESCRIPTION =
  'Wall-clock budget in ms for this dispatch; on expiry the child is killed (SIGTERM, then SIGKILL after 5s) and the result is marked timedOut. Minimum 1000.';

const TimeoutMsSchema = Type.Optional(
  Type.Number({ minimum: 1000, description: TIMEOUT_MS_DESCRIPTION }),
);

const RETRIES_DESCRIPTION =
  'Retry a failed child run up to N times (0–3, default 0). User aborts are never retried.';

const RetriesSchema = Type.Optional(
  Type.Number({ minimum: 0, maximum: 3, description: RETRIES_DESCRIPTION }),
);

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: TimeoutMsSchema,
  retries: RetriesSchema,
});

const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: TimeoutMsSchema,
  retries: RetriesSchema,
});

const AgentScopeSchema = Type.Union(
  [Type.Literal('user'), Type.Literal('project'), Type.Literal('both')],
  {
    description:
      'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: 'user',
  },
);

const SubagentParamsSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: 'Name of the agent to invoke (for single mode)' }),
  ),
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: TimeoutMsSchema,
  retries: RetriesSchema,
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'JSON Schema (single mode only) the child reply must match. Reply is parsed+lightly validated; value lands on results[0].data, or results[0].structuredError describes the failure.',
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: 'Prompt before running project-local agents. Default: true.',
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process (single mode)' }),
  ),
});

/** Resolved at module load: package root's agents/ dir (src/ → ../../agents). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = resolveBundledAgentsDir(import.meta.url);
void HERE; // retained for future path-relative needs

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate tasks to specialized subagents with isolated context.',
      'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
      "Default agent scope is 'user' (from ~/.pi/agent/agents).",
      "To enable project-local agents in .pi/agents, set agentScope: 'both' (or 'project').",
      'Optional thinkingLevel (off…max) per dispatch or per task scales reasoning effort;',
      'omit for the role default.',
    ].join(' '),
    parameters: SubagentParamsSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as Static<typeof SubagentParamsSchema>;
      const scope: AgentScope = p.agentScope ?? 'user';
      const discovery = discoverAgents(ctx.cwd, scope, BUNDLED_DIR);

      const dispatchCtx: DispatchContext = {
        cwd: ctx.cwd,
        hasUI: ctx.hasUI === true,
        isProjectTrusted: () => ctx.isProjectTrusted(),
        ui: {
          confirm: (title, message) =>
            ctx.ui.confirm(title, message) as unknown as Promise<boolean>,
        },
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        thinkingLevel: ctx.thinkingLevel,
        signal,
        onUpdate: onUpdate ?? undefined,
      };

      const out: ToolResultLike = await execute(p as SubagentParams, dispatchCtx, discovery.agents);

      const withProjectDir = (details: SubagentDetails): SubagentDetails => ({
        ...details,
        projectAgentsDir: discovery.projectAgentsDir,
      });

      return {
        content: out.content,
        details: withProjectDir(out.details),
        isError: out.isError,
      };
    },

    renderCall(args, theme) {
      // Theme seam: render.ts takes a minimal {bold, fg(string,string)} shape;
      // pi's Theme.fg is ThemeColor-typed. Cast at the boundary — render.ts only
      // passes the same literal color names the upstream extension uses.
      const s = renderCall(args as SubagentParams, theme as never);
      return new Text(s, 0, 0);
    },

    renderResult(result, opts, theme) {
      const s = renderResult(
        result as unknown as Parameters<typeof renderResult>[0],
        opts,
        theme as never,
      );
      return new Text(s, 0, 0);
    },
  });
}
