import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Text } from '@earendil-works/pi-tui';
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SubagentParams, SubagentDetails, SaveDetails } from './types.js';
import {
  resolveBundledAgentsDir,
  discoverAgents,
  findNearestProjectAgentsDir,
  getUserAgentsDir,
  type AgentScope,
  type AgentDiscoveryResult,
} from './agents.js';
import { saveAgentDefinition } from './agent-store.js';
import { syncBundledShadows, type SyncReport } from './agent-sync.js';
import { execute, type DispatchContext, type ToolResultLike } from './dispatch/index.js';
import { renderCall, renderResult } from './render.js';

const THINKING_LEVEL_DESCRIPTION =
  "Reasoning effort for this dispatch. Overrides the agent's frontmatter thinkingLevel and the default (medium for model-pinned agents; parent's level when the agent inherits the model).";

const THINKING_LEVEL_VALUES = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const ThinkingLevelSchema = Type.Union(
  THINKING_LEVEL_VALUES.map((l) => Type.Literal(l)),
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

const RETRY_BACKOFF_DESCRIPTION =
  'Base delay in ms before retry attempts (exponential: base, 2×, 4×; capped at 30s). 0 = immediate retry.';

const RetryBackoffMsSchema = Type.Optional(
  Type.Number({ minimum: 0, maximum: 60000, description: RETRY_BACKOFF_DESCRIPTION }),
);

const RetryOnSchema = Type.Optional(
  Type.Array(
    Type.Union([Type.Literal('error'), Type.Literal('timeout')], {
      description: "Failure class to retry: 'error' (non-zero exit / failed run) or 'timeout'.",
    }),
    {
      maxItems: 2,
      description:
        'Failure classes eligible for retry. Default: any failed result. Aborts are never retried.',
    },
  ),
);

const CHAIN_FAILURE_THRESHOLD_DESCRIPTION =
  'Chain mode circuit breaker (issue #2): stop the chain after this many consecutive failed steps. Default 1 = stop at the first failure (historical behavior). A tolerated failure continues with the last GOOD step output as {previous}; steps skipped by an open breaker are reported with stopReason "skipped_due_to_open_circuit" and details.circuitBreaker describes the trip.';

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: TimeoutMsSchema,
  retries: RetriesSchema,
  retryBackoffMs: RetryBackoffMsSchema,
  retryOn: RetryOnSchema,
  sessionDir: Type.Optional(Type.String({ description: 'Session storage directory override.' })),
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'JSON Schema for THIS item. Reply is parsed+validated (ajv); value lands on results[i].data, failures on results[i].structuredError.',
    }),
  ),
  session: Type.Optional(
    Type.Boolean({ description: 'Persist this run and report its session id.' }),
  ),
  resume: Type.Optional(Type.String({ description: 'Session id/path to continue.' })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  timeoutMs: TimeoutMsSchema,
  retries: RetriesSchema,
  retryBackoffMs: RetryBackoffMsSchema,
  retryOn: RetryOnSchema,
  sessionDir: Type.Optional(Type.String({ description: 'Session storage directory override.' })),
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'JSON Schema for THIS item. Reply is parsed+validated (ajv); value lands on results[i].data, failures on results[i].structuredError.',
    }),
  ),
  session: Type.Optional(
    Type.Boolean({ description: 'Persist this run and report its session id.' }),
  ),
  resume: Type.Optional(Type.String({ description: 'Session id/path to continue.' })),
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
  retryBackoffMs: RetryBackoffMsSchema,
  retryOn: RetryOnSchema,
  sessionDir: Type.Optional(
    Type.String({
      description: 'Session storage directory override (child --session-dir flag).',
    }),
  ),
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'JSON Schema (single mode only; set outputSchema per item in tasks/chain for parallel/chain use) the child reply must match. Reply is parsed+lightly validated; value lands on results[0].data, or results[0].structuredError describes the failure.',
    }),
  ),
  session: Type.Optional(
    Type.Boolean({
      description:
        'Persist this run as a pi session and report its id (SingleResult.sessionId) so later dispatches can resume it. Default: ephemeral.',
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        'Session id or path to continue from a prior run. Takes precedence over `session`.',
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' }),
  ),
  chainFailureThreshold: Type.Optional(
    Type.Number({ minimum: 1, maximum: 10, description: CHAIN_FAILURE_THRESHOLD_DESCRIPTION }),
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

const SaveAgentParamsSchema = Type.Object({
  name: Type.String({
    description:
      'Agent name — kebab-case (lowercase letters, digits, hyphens; starts and ends with a letter/digit; max 64). The definition is written to <name>.md.',
    pattern: '^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$',
  }),
  description: Type.String({
    description: 'One-line description of what the agent is for (required by the loader).',
    minLength: 1,
  }),
  systemPrompt: Type.String({
    description: 'Full system prompt for the child agent (becomes the body of the .md file).',
    minLength: 1,
  }),
  tools: Type.Optional(
    Type.String({
      description:
        "Comma-separated tools the child may use, e.g. 'read, grep, bash'. Omit to inherit the default tool set.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Provider/model id pin (e.g. minimax/minimax-m2.5). Wins over tier at dispatch — set one, not both.',
    }),
  ),
  tier: Type.Optional(
    Type.Union([Type.Literal('cheap'), Type.Literal('thinking')], {
      description:
        "Cost tier: 'cheap' (routine offload) or 'thinking' (deep-reasoning offload). Ignored when model is also set.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  scope: Type.Optional(
    Type.Union([Type.Literal('user'), Type.Literal('project')], {
      description:
        "Where to write: 'user' (~/.pi/agent/agents — available in every project; default) or 'project' (the project's nearest .pi/agents — shared via the repo; requires a trusted project).",
      default: 'user',
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description:
        'Required ONLY to shadow a bundled agent name or apply a MAJOR update (tools/model/tier/thinkingLevel changed, or a large prompt rewrite). Minor updates never need this. Set it only when the user agreed to replace that agent.',
      default: false,
    }),
  ),
});

/** Resolved at module load: package root's agents/ dir (src/ → ../../agents). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = resolveBundledAgentsDir(import.meta.url);
void HERE; // retained for future path-relative needs

/**
 * Injection seams for tests (and embedding apps). All defaults resolve from
 * getAgentDir() at CALL time so the PI_CODING_AGENT_DIR env override is
 * honored whenever the extension actually runs.
 */
export interface SubagentExtensionDeps {
  /** Bundled-shadow sync implementation (defaults to src/agent-sync.ts). */
  syncBundledShadows?: (opts: {
    bundledDir: string;
    userDir: string;
    basesDir: string;
  }) => Promise<SyncReport[]> | SyncReport[];
  dirs?: {
    /** Default: getUserAgentsDir() (~/.pi/agent/agents). */
    userAgentsDir?: string;
    /** Default: ~/.pi/agent/pisubagent/bases. */
    basesDir?: string;
  };
}

/** True when `filePath` lives at or under `dir`. */
function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function formatSyncNotes(reports: SyncReport[]): string[] {
  return reports.map((r) => `[agent-sync] ${r.agent} (${r.action}): ${r.detail}`);
}

/**
 * Run bundled-shadow sync with full degradation: per-agent failures are
 * already isolated inside syncBundledShadows; a whole-function failure
 * degrades to a skipped-sync note. Sync must never fail a dispatch.
 */
async function runAgentSync(deps: SubagentExtensionDeps, userDir: string, basesDir: string) {
  try {
    return await (deps.syncBundledShadows ?? syncBundledShadows)({
      bundledDir: BUNDLED_DIR,
      userDir,
      basesDir,
    });
  } catch {
    return [
      {
        agent: '*',
        action: 'skipped' as const,
        detail: 'bundled-shadow sync failed and was skipped',
      },
    ];
  }
}

/** Defensive discovery wrapper: never let a bad directory crash a tool. */
function safeDiscoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult | { error: Error } {
  try {
    return discoverAgents(cwd, scope, BUNDLED_DIR);
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function discoveryErrorMessage(err: Error): string {
  return (
    `Agent discovery failed: ${err.message}. One of the agent directories ` +
    '(~/.pi/agent/agents, .pi/agents, or the bundled agents/) contains a file that could not be read or parsed. ' +
    'Fix or remove the offending .md file and retry.'
  );
}

export default function (pi: ExtensionAPI, deps: SubagentExtensionDeps = {}) {
  const dirs = {
    userAgentsDir: deps.dirs?.userAgentsDir ?? getUserAgentsDir(),
    basesDir: deps.dirs?.basesDir ?? path.join(getAgentDir(), 'pisubagent', 'bases'),
  };

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
      "Optional tier ('cheap' | 'thinking') routes the run to an offload model",
      '(defaults: MiniMax M2.5 / M3 — overridable in ~/.pi/agent/pisubagent.tiers.json)',
      'to preserve the primary provider quota; tier-routed runs fall back to the parent model once on failure.',
    ].join(' '),
    parameters: SubagentParamsSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as Static<typeof SubagentParamsSchema>;
      const scope: AgentScope = p.agentScope ?? 'user';

      // Bundled-shadow sync before discovery (skipped for project scope,
      // where bundled/user agents are not loaded at all).
      let syncNotes: string[] = [];
      if (scope !== 'project') {
        syncNotes = formatSyncNotes(await runAgentSync(deps, dirs.userAgentsDir, dirs.basesDir));
      }

      const discovered = safeDiscoverAgents(ctx.cwd, scope);
      if ('error' in discovered) {
        return {
          content: [{ type: 'text', text: discoveryErrorMessage(discovered.error) }],
          details: {
            mode: 'single',
            agentScope: scope,
            projectAgentsDir: null,
            results: [],
            agentSyncNotes: syncNotes.length > 0 ? syncNotes : undefined,
          },
          isError: true,
        } satisfies ToolResultLike & { details: SubagentDetails };
      }
      const discovery = discovered;

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
        agentSyncNotes: syncNotes.length > 0 ? syncNotes : details.agentSyncNotes,
      });

      return {
        content:
          syncNotes.length > 0
            ? [...out.content, { type: 'text' as const, text: syncNotes.join('\n') }]
            : out.content,
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

  pi.registerTool({
    name: 'subagent_save',
    label: 'Subagent Save',
    description: [
      'Persist or update a subagent definition (Markdown + frontmatter) so future subagent dispatches can use it by name.',
      "Writes to ~/.pi/agent/agents (scope 'user', default) or the project's nearest .pi/agents (scope 'project'; requires a trusted project).",
      'Upsert policy: a missing agent is created; MINOR changes (description tweaks, small prompt edits — up to 20% of prompt lines) are updated automatically;',
      'MAJOR changes (tools/model/tier/thinkingLevel changed, or a large prompt rewrite) are BLOCKED with a diff summary.',
      "A 'blocked' result is expected behavior, NOT a transient failure: do not retry with overwrite: true unless the user explicitly agreed to replace that agent — pick a different name or ask.",
      'Saving a name that exists as a bundled agent also requires overwrite: true (it shadows the bundled definition).',
    ].join(' '),
    parameters: SaveAgentParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as Static<typeof SaveAgentParamsSchema>;
      const scope = p.scope ?? 'user';

      // Refresh provenance state before diffing against what's on disk.
      let syncNotes: string[] = [];
      if (scope !== 'project') {
        syncNotes = formatSyncNotes(await runAgentSync(deps, dirs.userAgentsDir, dirs.basesDir));
      }

      const buildResult = (
        details: SaveDetails,
        text: string,
        isError: boolean,
      ): {
        content: Array<{ type: 'text'; text: string }>;
        details: SaveDetails;
        isError: boolean;
      } => ({
        content:
          syncNotes.length > 0
            ? [
                { type: 'text' as const, text },
                { type: 'text' as const, text: syncNotes.join('\n') },
              ]
            : [{ type: 'text' as const, text }],
        details,
        isError,
      });

      // Project scope: write-block on untrusted projects (stronger than the
      // run gate, which only confirms before EXECUTING untrusted agents —
      // see docs/adr/0004).
      if (scope === 'project' && !ctx.isProjectTrusted()) {
        return buildResult(
          { action: 'blocked' },
          "NOT saved: scope 'project' requires a trusted project. Trust this project in pi's project settings, or save to user scope (scope: 'user') instead.",
          true,
        );
      }

      const targetDir =
        scope === 'project'
          ? (findNearestProjectAgentsDir(ctx.cwd) ?? path.join(ctx.cwd, CONFIG_DIR_NAME, 'agents'))
          : dirs.userAgentsDir;

      const discovered = safeDiscoverAgents(ctx.cwd, 'both');
      if ('error' in discovered) {
        return buildResult({ action: 'error' }, discoveryErrorMessage(discovered.error), true);
      }

      const otherSources = discovered.agents.filter((a) => !isInsideDir(a.filePath, targetDir));

      const outcome = await saveAgentDefinition(
        {
          name: p.name,
          description: p.description,
          systemPrompt: p.systemPrompt,
          tools: p.tools,
          model: p.model,
          tier: p.tier,
          thinkingLevel: p.thinkingLevel,
          overwrite: p.overwrite,
        },
        { targetDir, sourceLabel: scope, otherSources, basesDir: dirs.basesDir },
      );

      const details: SaveDetails = {
        action: outcome.action,
        filePath: outcome.filePath,
        changedFields: outcome.change?.fields,
        warnings: outcome.warnings.length > 0 ? outcome.warnings : undefined,
      };
      const text = [outcome.message, ...outcome.warnings].join('\n');
      return buildResult(details, text, !outcome.ok);
    },
  });
}
