import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentRunner, AgentRunInput } from "./runner.js";
import type { SingleResult, UsageStats } from "../types.js";

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

export interface SubprocessRunnerOptions {
  /** Injectable spawn for tests; defaults to node:child_process spawn. */
  spawnFn?: typeof spawn;
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export class SubprocessRunner implements AgentRunner {
  readonly id = "subprocess" as const;
  private readonly spawnFn: typeof spawn;

  constructor(options: SubprocessRunnerOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Pure CLI-flag prefix composition. Order is stable for tests:
   * --mode json -p --no-session [--model M] [--thinking T] [--tools list]
   * (run() appends [--append-system-prompt tmp] and the Task: line afterwards.)
   */
  buildArgs(
    input: AgentRunInput,
    dispatchDefaults: { parentModel?: string; parentThinkingLevel?: ThinkingLevel },
  ): string[] {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    const inheritsDispatchConfig = !input.agent.model;
    const model = input.agent.model ?? dispatchDefaults.parentModel;
    if (model) args.push("--model", model);
    if (inheritsDispatchConfig && dispatchDefaults.parentThinkingLevel) {
      args.push("--thinking", dispatchDefaults.parentThinkingLevel);
    }
    if (input.agent.tools && input.agent.tools.length > 0) {
      args.push("--tools", input.agent.tools.join(","));
    }
    return args;
  }

  /**
   * Suffix segments appended after buildArgs: the system-prompt flag (sentinel
   * for tests; real path substituted in run()) and the final Task: prompt.
   */
  buildSuffix(systemPrompt: string, task: string): string[] {
    const suffix: string[] = [];
    if (systemPrompt.trim()) suffix.push("--append-system-prompt", "<tempFile>");
    suffix.push(`Task: ${task}`);
    return suffix;
  }

  async run(
    input: AgentRunInput,
    signal?: AbortSignal,
    onUpdate?: (partial: SingleResult) => void,
  ): Promise<SingleResult> {
    const args = this.buildArgs(input, {
      parentModel: input.parentModel,
      parentThinkingLevel: input.parentThinkingLevel,
    });

    const result: SingleResult = {
      agent: input.agent.name,
      agentSource: input.agent.source === "bundled" ? "user" : input.agent.source,
      task: input.task,
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      model: input.agent.model ?? input.parentModel,
    };

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;
    let wasAborted = false;

    try {
      if (input.agent.systemPrompt.trim()) {
        const tmp = await writePromptFile(input.agent.name, input.agent.systemPrompt);
        tmpPromptDir = tmp.dir;
        tmpPromptPath = tmp.filePath;
        args.push("--append-system-prompt", tmpPromptPath);
      }
      args.push(`Task: ${input.resolvedTask ?? input.task}`);

      const exitCode = await new Promise<number>((resolve) => {
        const invocation = resolvePiInvocation(args);
        const proc: ChildProcess = this.spawnFn(invocation.command, invocation.args, {
          cwd: input.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let buffer = "";
        const ingest = (msg: Message) => {
          result.messages.push(msg);
          if (msg.role === "assistant") {
            result.usage.turns += 1;
            const usage = (
              msg as unknown as { usage?: Partial<UsageStats & { totalTokens?: number }> }
            ).usage;
            if (usage) {
              result.usage.input += usage.input || 0;
              result.usage.output += usage.output || 0;
              result.usage.cacheRead += usage.cacheRead || 0;
              result.usage.cacheWrite += usage.cacheWrite || 0;
              result.usage.cost += usage.cost || 0;
              result.usage.contextTokens = usage.totalTokens ?? result.usage.contextTokens;
            }
            const meta = msg as unknown as {
              model?: string;
              stopReason?: string;
              errorMessage?: string;
            };
            if (meta.model && !result.model) result.model = meta.model;
            if (meta.stopReason) result.stopReason = meta.stopReason;
            if (meta.errorMessage) result.errorMessage = meta.errorMessage;
          }
          onUpdate?.(result);
        };

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let event: { type?: string; message?: unknown };
          try {
            event = JSON.parse(trimmed);
          } catch {
            return;
          }
          if (event.type === "message_end" && event.message) {
            ingest(event.message as Message);
          }
        };

        if (proc.stdout) {
          proc.stdout.on("data", (chunk: Buffer | string) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
          });
        }
        if (proc.stderr) {
          proc.stderr.on("data", (chunk: Buffer | string) => {
            result.stderr += chunk.toString();
          });
        }

        proc.on("close", (code) => {
          if (buffer.trim()) processLine(buffer);
          resolve(code ?? 0);
        });
        proc.on("error", () => resolve(1));

        if (signal) {
          const onAbort = () => {
            wasAborted = true;
            proc.kill("SIGTERM");
            setTimeout(() => {
              if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
            }, 5000);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      result.exitCode = exitCode;
      if (wasAborted) result.stopReason = "aborted";
      else if (exitCode !== 0 && !result.stopReason) result.stopReason = "error";
      return result;
    } finally {
      if (tmpPromptPath) {
        try {
          fs.unlinkSync(tmpPromptPath);
        } catch {
          /* ignore */
        }
      }
      if (tmpPromptDir) {
        try {
          fs.rmdirSync(tmpPromptDir);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
