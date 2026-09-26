import type { AgentToolResult, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

export interface SubagentParams {
  agent?: string;
  task?: string;
  thinkingLevel?: ThinkingLevel;
  /** Wall-clock budget in ms for the child process (single mode). */
  timeoutMs?: number;
  /** Retry attempts for a failed child run (single mode). 0–3, default 0. */
  retries?: number;
  /** JSON Schema the child's reply must satisfy (single mode only, v1). */
  outputSchema?: Record<string, unknown>;
  /** Persist this run's session and report its id (single mode). */
  session?: boolean;
  /** Session id or path to continue (single mode). Wins over `session`. */
  resume?: string;
  tasks?: Array<{
    agent: string;
    task: string;
    cwd?: string;
    thinkingLevel?: ThinkingLevel;
    timeoutMs?: number;
    retries?: number;
    session?: boolean;
    resume?: string;
  }>;
  chain?: Array<{
    agent: string;
    task: string;
    cwd?: string;
    thinkingLevel?: ThinkingLevel;
    timeoutMs?: number;
    retries?: number;
    session?: boolean;
    resume?: string;
  }>;
  agentScope?: 'user' | 'project' | 'both';
  confirmProjectAgents?: boolean;
  cwd?: string;
}

export type Mode = 'single' | 'parallel' | 'chain';

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: 'user' | 'project' | 'unknown';
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  /** Effective thinking level the run was launched with (see src/thinking.ts). */
  thinkingLevel?: ThinkingLevel;
  stopReason?: string;
  /** True when the run was ended by the per-dispatch/runner timeout (not user abort). */
  timedOut?: boolean;
  /** Total attempts made when retries were configured (absent when 1 attempt). */
  attempts?: number;
  /** Path to the full stdout artifact when output exceeded the 1MB in-memory cap. */
  outputFile?: string;
  /** Parsed structured output when outputSchema was given and the reply parsed+validated. */
  data?: unknown;
  /** Set when structured extraction failed (parse or validation). Never silent: check this. */
  structuredError?: string;
  /** Child session id when the run was persisted (session/resume). */
  sessionId?: string;
  errorMessage?: string;
  step?: number;
  /** True while this agent is still executing (progress snapshots); false once settled. */
  running?: boolean;
}

export interface SubagentDetails {
  mode: Mode;
  agentScope: 'user' | 'project' | 'both';
  projectAgentsDir: string | null;
  results: SingleResult[];
  /** Aggregate usage across results (parallel/chain only; absent for single). */
  usage?: UsageStats;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface AgentRunInput {
  agent: AgentConfig;
  task: string;
  cwd: string;
  parentModel?: string;
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

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /** Per-role thinking level from frontmatter; beats the dispatch default. */
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
  source: 'user' | 'project' | 'bundled';
  filePath: string;
}
