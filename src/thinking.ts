import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

/**
 * Shared thinking-level resolution for subagent dispatch.
 *
 * Today a model-pinned agent never receives `--thinking`, so the child `pi`
 * process silently falls back to its own default (`max`) — slow and expensive
 * for routine delegation. Resolution is dynamic, most-specific wins:
 *
 * 1. Per-dispatch override — `thinkingLevel` on the tool call (single /
 *    tasks item / chain item). Lets the dispatching LLM scale reasoning to
 *    the task at hand.
 * 2. Per-role — `thinkingLevel:` frontmatter in the agent's .md file.
 * 3. Inherited — the parent session's level, when the agent also inherits
 *    the parent's model (no `model:` pinned; existing dispatch contract).
 * 4. `DEFAULT_SUBAGENT_THINKING` — applied when the agent pins its own model.
 * 5. `undefined` — no model resolved anywhere; the child `pi` CLI decides
 *    both model and thinking level.
 */

/** All valid ThinkingLevel values; used for frontmatter and schema validation. */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ThinkingLevel[];

/**
 * Thinking level for agents that pin a model via frontmatter and declare
 * nothing else. `medium` is a sane reasoning budget for routine delegation;
 * roles needing more declare `thinkingLevel:` themselves (or the caller
 * overrides per dispatch).
 */
export const DEFAULT_SUBAGENT_THINKING: ThinkingLevel = 'medium';

/** Lenient frontmatter parser: invalid or absent values yield undefined. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingLevel)
    : undefined;
}

export interface ThinkingResolutionInput {
  /** `thinkingLevel` from the tool call (single param, tasks item, chain item). */
  thinkingLevelOverride?: ThinkingLevel;
  /** `ctx.thinkingLevel` from the dispatching session. */
  parentThinkingLevel?: ThinkingLevel;
}

/**
 * Resolve the effective thinking level for one subagent run.
 * See module doc for the precedence ladder.
 */
export function resolveThinkingLevel(
  agent: { model?: string; thinkingLevel?: ThinkingLevel },
  input: ThinkingResolutionInput,
): ThinkingLevel | undefined {
  if (input.thinkingLevelOverride) return input.thinkingLevelOverride;
  if (agent.thinkingLevel) return agent.thinkingLevel;
  if (!agent.model) return input.parentThinkingLevel;
  return DEFAULT_SUBAGENT_THINKING;
}
