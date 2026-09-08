import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface PiInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve how to invoke a child `pi` process.
 * - Prefer re-invoking the current entrypoint (process.execPath + current script).
 * - Fall back to bare `pi` on PATH for bun virtual filesystems or missing scripts.
 */
export function resolvePiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/**
 * Write an agent's system prompt to a mode-0600 temp file for
 * `--append-system-prompt`. Caller owns cleanup of the returned dir.
 */
export async function writePromptFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

/**
 * Kill `proc` when `signal` aborts: SIGTERM immediately, SIGKILL after 5s grace.
 * If the signal is already aborted, kills immediately.
 */
export function killOnAbort(proc: ChildProcess, signal: AbortSignal): void {
  const killProc = () => {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  };
  if (signal.aborted) killProc();
  else signal.addEventListener("abort", killProc, { once: true });
}

export type JsonlEvent = Record<string, unknown> & { type?: string };

/**
 * Parse newline-delimited JSON from a buffered stream chunk.
 * Malformed and blank lines are skipped silently.
 */
export function* parseJsonlEvents(stream: string): IterableIterator<JsonlEvent> {
  for (const line of stream.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as JsonlEvent;
    } catch {
      // skip malformed lines
    }
  }
}
