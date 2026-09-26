import type { AgentToolResult, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { SingleResult, AgentConfig, SubagentDetails } from '../types.js';

export interface AgentRunInput {
  agent: AgentConfig;
  task: string;
  cwd: string;
  /** ctx.model.provider/id from the dispatching session; default model when agent.model unset. */
  parentModel?: string;
  /** ctx.thinkingLevel from the dispatching session; inherited when the agent also inherits the model. */
  parentThinkingLevel?: ThinkingLevel;
  /** Per-dispatch override from the tool call; beats frontmatter and parent. */
  thinkingLevelOverride?: ThinkingLevel;
  /** Per-dispatch timeout in ms; beats the runner-level runTimeoutMs. */
  timeoutMs?: number;
  /** Opt-in: persist this run's session (runner generates the id). */
  session?: boolean;
  /** Continue this session id/path; wins over `session`. */
  resume?: string;
  /** Pre-computed session id (tests/dispatch injection). */
  sessionId?: string;
  /** Pre-substituted text replacing {previous} for chain steps. */
  resolvedTask?: string;
}

export type AgentRunnerId = 'subprocess' | 'in-process';

export type OnUpdatePartial = (partial: SingleResult) => void;

export interface AgentRunner {
  readonly id: AgentRunnerId;
  run(
    input: AgentRunInput,
    signal?: AbortSignal,
    onUpdate?: OnUpdatePartial,
  ): Promise<SingleResult>;
}

// Re-exports so consumers don't reach into multiple packages for common types.
export type { AgentToolResult, ThinkingLevel, SingleResult, SubagentDetails };
