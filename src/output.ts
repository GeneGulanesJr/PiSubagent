import * as os from 'node:os';
import type { Message } from '@earendil-works/pi-ai';
import type { UsageStats, SingleResult } from './types.js';

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function truncateParallelOutput(output: string, capBytes: number): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= capBytes) return output;

  let truncated = output.slice(0, capBytes);
  while (Buffer.byteLength(truncated, 'utf8') > capBytes) {
    truncated = truncated.slice(0, -1);
  }
  const omitted = byteLength - Buffer.byteLength(truncated, 'utf8');
  return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'text') items.push({ type: 'text', text: part.text });
      else if (part.type === 'toolCall') {
        items.push({
          type: 'toolCall',
          name: part.name,
          args: part.arguments as Record<string, unknown>,
        });
      }
    }
  }
  return items;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(' ');
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string,
): string {
  const shortenPath = (p: string): string => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case 'bash': {
      const command = (args.command as string) || '...';
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview);
    }
    case 'read': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'read ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'write': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'write ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'edit': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'ls': {
      const rawPath = (args.path || '.') as string;
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'find': {
      const pattern = (args.pattern || '*') as string;
      const rawPath = (args.path || '.') as string;
      return (
        themeFg('muted', 'find ') +
        themeFg('accent', pattern) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    case 'grep': {
      const pattern = (args.pattern || '') as string;
      const rawPath = (args.path || '.') as string;
      return (
        themeFg('muted', 'grep ') +
        themeFg('accent', `/${pattern}/`) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`);
    }
  }
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') return part.text;
      }
    }
  }
  return '';
}

/**
 * Latest activity snippet for a running subagent result, suitable for a
 * single-line progress display. Format precedence:
 *   1. The last assistant text part (whitespace-collapsed, truncated).
 *   2. The name of the most recent tool call as "→ toolName".
 *   3. "(starting…)" if no assistant output yet.
 */
export const PROGRESS_SNIPPET_MAX = 120;

export function progressSnippet(messages: readonly Message[]): string {
  if (messages.length === 0) return '(starting…)';
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return '(starting…)';
  for (let i = last.content.length - 1; i >= 0; i--) {
    const part = last.content[i];
    if (part.type === 'text' && part.text.trim()) {
      const text = part.text.replace(/\s+/g, ' ').trim();
      return text.length > PROGRESS_SNIPPET_MAX
        ? `${text.slice(0, PROGRESS_SNIPPET_MAX - 1)}…`
        : text;
    }
    if (part.type === 'toolCall') {
      return `→ ${part.name}`;
    }
  }
  return '(starting…)';
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)';
  }
  return getFinalOutput(result.messages) || '(no output)';
}
