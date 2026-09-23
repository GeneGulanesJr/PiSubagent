import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { SubagentDetails, OnUpdateCallback } from '../types.js';

/**
 * Context the dispatch orchestrator needs from the calling extension
 * session. Spread by `src/index.ts` from the live pi ExtensionContext.
 */
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

/**
 * Minimal structural shape of a tool result, decoupled from the upstream
 * AgentToolResult generic so dispatch helpers don't need to import the
 * heavyweight pi-agent-core surface.
 */
export interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}
