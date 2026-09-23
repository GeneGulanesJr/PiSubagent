import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { SubagentDetails, Mode, SingleResult, OnUpdateCallback } from '../types.js';
import { progressSnippet, formatTokens } from '../output.js';

export const PROGRESS_THROTTLE_MS = 150;

export type ProgressPayload = AgentToolResult<SubagentDetails>;

/**
 * Build the per-mode progress headline string that lands in
 * `content[0].text` for each `onUpdate` emission. Surfaces running/done
 * counts, per-agent icons, and the latest text snippet from each agent's
 * last assistant message.
 */
function progressLine(mode: Mode, results: readonly SingleResult[], total: number): string {
  const done = results.filter((r) => !r.running).length;
  if (mode === 'single') {
    const r = results[0];
    if (!r) return 'Running…';
    if (!r.running) return `${r.agent}: done`;
    const latest = progressSnippet(r.messages);
    return `${r.agent}: ${latest} (${r.messages.length} msg, ↓${formatTokens(r.usage.output)} tok)`;
  }
  if (mode === 'parallel') {
    const header = `Running ${total} subagent${total === 1 ? '' : 's'}… (${done}/${total} done)`;
    const perAgent = results
      .map((r) => {
        const icon = r.running ? '◐' : r.exitCode === 0 ? '✓' : '✗';
        const latest = progressSnippet(r.messages);
        const runningTag = r.running ? '' : r.exitCode === 0 ? ' done' : ` failed`;
        return `  ${icon} ${r.agent}: ${latest}${runningTag}`;
      })
      .join('\n');
    return perAgent ? `${header}\n${perAgent}` : header;
  }
  // chain: surface the current (last) step's latest text.
  const current = results[results.length - 1];
  if (!current) return `Step 0/${total}: starting…`;
  const latest = progressSnippet(current.messages);
  return current.running
    ? `Step ${results.length}/${total} ${current.agent}: ${latest} (${current.messages.length} msg, ↓${formatTokens(current.usage.output)} tok)`
    : `Step ${results.length}/${total} ${current.agent}: done`;
}

/**
 * Snapshot of the dispatch state suitable for a single `onUpdate` call.
 * Deep-clones each `results[i]` so consumers can't mutate the live array
 * via the payload reference.
 */
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

export { progressLine, snapshot };
