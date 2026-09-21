import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export interface SubagentParams {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string; cwd?: string }>;
  chain?: Array<{ agent: string; task: string; cwd?: string }>;
  agentScope?: "user" | "project" | "both";
  confirmProjectAgents?: boolean;
  cwd?: string;
}

export type Mode = "single" | "parallel" | "chain";

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
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  /** True while this agent is still executing (progress snapshots); false once settled. */
  running?: boolean;
}

export interface SubagentDetails {
  mode: Mode;
  agentScope: "user" | "project" | "both";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface AgentRunInput {
  agent: AgentConfig;
  task: string;
  cwd: string;
  parentModel?: string;
  parentThinkingLevel?: ThinkingLevel;
  /** Pre-substituted text replacing {previous} for chain steps. */
  resolvedTask?: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project" | "bundled";
  filePath: string;
}
