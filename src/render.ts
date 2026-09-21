import type { SubagentParams, SubagentDetails, SingleResult } from "./types.js";
import { getDisplayItems, formatUsageStats, formatToolCall, getFinalOutput, isFailedResult } from "./output.js";

/**
 * Theme-injected renderers (no extension I/O). Mirrors upstream Pi TUI output
 * conventions: ✓/✗ status icons, → tool-call lines, dim usage footer.
 * Callers pass the active Pi theme; we only use fg/bold shape.
 */
export interface TuiTheme {
  bold: (s: string) => string;
  fg: (color: string, text: string) => string;
}

const COLLAPSED_ITEM_COUNT = 10;

export function renderCall(args: SubagentParams, theme: TuiTheme): string {
  const scope = args.agentScope ?? "user";

  if (args.chain && args.chain.length > 0) {
    let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length} steps)`)}${theme.fg("muted", ` [${scope}]`)}`;
    for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
      const step = args.chain[i];
      const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
      const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
    return text;
  }

  if (args.tasks && args.tasks.length > 0) {
    let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}${theme.fg("muted", ` [${scope}]`)}`;
    for (const t of args.tasks.slice(0, 3)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
      text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
    return text;
  }

  const agentName = args.agent || "...";
  const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
  return `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agentName)}${theme.fg("muted", ` [${scope}]`)}\n  ${theme.fg("dim", preview)}`;
}

export function renderResult(
  result: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails; isError?: boolean },
  opts: { expanded?: boolean; isPartial?: boolean },
  theme: TuiTheme,
): string {
  const details = result.details;
  const results = details.results;

  if (results.length === 0) {
    return result.content[0]?.text ?? "(no output)";
  }

  if (details.mode === "single" && results.length === 1) {
    return renderSingleResult(results[0], opts.expanded === true, theme);
  }

  return renderMultiResult(details.mode, results, theme, opts.isPartial === true);
}

const RUNNING_ICON = "◐";

function renderSingleResult(r: SingleResult, expanded: boolean, theme: TuiTheme): string {
  const failed = isFailedResult(r);
  const icon = r.running
    ? theme.fg("accent", RUNNING_ICON)
    : failed
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");

  let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
  if (r.running) text += theme.fg("muted", " running…");
  if (failed && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  if (failed && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;

  const displayItems = getDisplayItems(r.messages);
  if (displayItems.length === 0 && !failed) {
    if (!r.running) text += `\n${theme.fg("muted", "(no output)")}`;
  } else {
    const toShow = displayItems.slice(-COLLAPSED_ITEM_COUNT);
    const skipped = displayItems.length - toShow.length;
    if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`;
    for (const item of toShow) {
      if (item.type === "text") {
        text += `\n${theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n"))}`;
      } else {
        text += `\n${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg)}`;
      }
    }
  }

  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;

  if (expanded) {
    const finalOutput = getFinalOutput(r.messages);
    if (finalOutput) text += `\n\n${finalOutput.trim()}`;
  }

  return text;
}

function renderMultiResult(
  mode: SubagentDetails["mode"],
  results: SingleResult[],
  theme: TuiTheme,
  isPartial = false,
): string {
  const successCount = results.filter((r) => !isFailedResult(r) && !r.running).length;
  const failedCount = results.filter((r) => isFailedResult(r)).length;
  const doneCount = results.filter((r) => !r.running).length;

  const icon = isPartial
    ? theme.fg("accent", RUNNING_ICON)
    : failedCount === 0
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");
  const count = isPartial ? doneCount : successCount;

  let text = `${icon} ${theme.fg("toolTitle", theme.bold(mode))} ${theme.fg("accent", `${count}/${results.length}`)}`;
  for (const r of results) {
    const rIcon = r.running
      ? theme.fg("accent", RUNNING_ICON)
      : isFailedResult(r)
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
    text += `\n  ${rIcon} ${theme.fg("accent", r.agent)}`;
  }
  return text;
}
