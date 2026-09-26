import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentRunner, AgentRunInput } from '../runner.js';
import type { SingleResult, UsageStats } from '../../types.js';
import { resolvePiInvocation } from './invocation.js';
import { writePromptFile } from './prompt-file.js';
import { resolveThinkingLevel } from '../../thinking.js';

/** Hard cap on stdout line buffer / stderr accumulator per run (1 MB). */
const MAX_BUFFER_BYTES = 1024 * 1024;

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Create the spill artifact for stdout overflow: a fresh mkdtemp dir in the
 * OS tmpdir holding one `<agent>.log` file. The dir is intentionally NOT
 * cleaned up — the file is the caller's artifact. Returns null when tmpdir
 * creation fails, in which case the runner falls back to plain truncation.
 */
function createSpillFile(agentName: string): string | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-spill-'));
    const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.log`);
  } catch {
    return null;
  }
}

export interface SubprocessRunnerOptions {
  /** Injectable spawn for tests; defaults to node:child_process spawn. */
  spawnFn?: typeof spawn;
  /**
   * Optional hard timeout in milliseconds. If the subprocess hasn't
   * exited within this window, SIGTERM is sent (escalating to SIGKILL
   * after 5s) and the run is finalized with `stopReason: "aborted"` and
   * `errorMessage: "run timeout after Xms"`. Default: no timeout.
   */
  runTimeoutMs?: number;
}

export class SubprocessRunner implements AgentRunner {
  readonly id = 'subprocess' as const;
  private readonly spawnFn: typeof spawn;
  private readonly runTimeoutMs?: number;

  constructor(options: SubprocessRunnerOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.runTimeoutMs = options.runTimeoutMs;
  }

  /**
   * Pure CLI-flag prefix composition. Order is stable for tests:
   * --mode json -p [--session S | --session-id I | --no-session] [--model M] ...
   * (run() appends [--append-system-prompt tmp] and the Task: line afterwards.)
   *
   * Thinking level resolution (most specific wins): per-dispatch override →
   * agent frontmatter → parent inheritance (only when the agent inherits the
   * parent's model) → DEFAULT_SUBAGENT_THINKING for model-pinned agents.
   * See src/thinking.ts.
   */
  buildArgs(
    input: AgentRunInput,
    dispatchDefaults: { parentModel?: string; parentThinkingLevel?: ThinkingLevel },
  ): string[] {
    const args: string[] = ['--mode', 'json', '-p'];
    if (input.resume) {
      // Continue a prior session: takes precedence over --no-session and --session-id.
      args.push('--session', input.resume);
    } else if (input.sessionId) {
      // Opt-in persistence: exact id, created by the child CLI if missing.
      args.push('--session-id', input.sessionId);
    } else {
      args.push('--no-session');
    }
    const model = input.agent.model ?? dispatchDefaults.parentModel;
    if (model) args.push('--model', model);
    const thinking = resolveThinkingLevel(input.agent, {
      thinkingLevelOverride: input.thinkingLevelOverride,
      parentThinkingLevel: dispatchDefaults.parentThinkingLevel,
    });
    if (thinking) args.push('--thinking', thinking);
    if (input.agent.tools && input.agent.tools.length > 0) {
      args.push('--tools', input.agent.tools.join(','));
    }
    return args;
  }

  /**
   * Suffix segments appended after buildArgs: the system-prompt flag (sentinel
   * for tests; real path substituted in run()) and the final Task: prompt.
   */
  buildSuffix(systemPrompt: string, task: string): string[] {
    const suffix: string[] = [];
    if (systemPrompt.trim()) suffix.push('--append-system-prompt', '<tempFile>');
    suffix.push(`Task: ${task}`);
    return suffix;
  }

  async run(
    input: AgentRunInput,
    signal?: AbortSignal,
    onUpdate?: (partial: SingleResult) => void,
  ): Promise<SingleResult> {
    const sessionId = input.resume ?? input.sessionId ?? (input.session ? randomUUID() : undefined);
    const args = this.buildArgs(
      { ...input, sessionId },
      {
        parentModel: input.parentModel,
        parentThinkingLevel: input.parentThinkingLevel,
      },
    );
    const thinkingLevel = resolveThinkingLevel(input.agent, {
      thinkingLevelOverride: input.thinkingLevelOverride,
      parentThinkingLevel: input.parentThinkingLevel,
    });

    const result: SingleResult = {
      agent: input.agent.name,
      agentSource: input.agent.source === 'bundled' ? 'user' : input.agent.source,
      task: input.task,
      exitCode: 0,
      messages: [],
      stderr: '',
      usage: emptyUsage(),
      model: input.agent.model ?? input.parentModel,
      thinkingLevel,
      sessionId,
    };

    let tmpPromptDir: string | null = null;
    let wasAborted = false;
    let didTimeOut = false;
    let droppedJsonlCount = 0;
    let onUpdateErrorLogged = false;
    let spillPath: string | null = null;

    /**
     * Append to stderr but never grow past MAX_BUFFER_BYTES. Used by both
     * the live stderr stream (Bug 2) and the post-close JSONL-drop
     * summary (Bug 7) so neither can OOM the parent.
     */
    const appendStderr = (text: string) => {
      if (text.length === 0) return;
      if (result.stderr.length > MAX_BUFFER_BYTES) return;
      result.stderr += text;
      if (result.stderr.length > MAX_BUFFER_BYTES) {
        // Truncate at the cap so subsequent appends are short-circuited.
        result.stderr = result.stderr.slice(0, MAX_BUFFER_BYTES);
      }
    };

    try {
      if (input.agent.systemPrompt.trim()) {
        try {
          const tmp = await writePromptFile(input.agent.name, input.agent.systemPrompt);
          tmpPromptDir = tmp.dir;
          args.push('--append-system-prompt', tmp.filePath);
        } catch (err) {
          // writePromptFile already self-cleaned its tmpdir. Continue
          // without the system prompt so a transient tmpdir failure
          // doesn't kill an entire dispatch.
          const msg = err instanceof Error ? err.message : String(err);
          appendStderr(`[subprocess: failed to write system prompt: ${msg}]\n`);
        }
      }
      args.push(`Task: ${input.resolvedTask ?? input.task}`);

      const exitCode = await new Promise<number>((resolve) => {
        const invocation = resolvePiInvocation(args);
        const proc: ChildProcess = this.spawnFn(invocation.command, invocation.args, {
          cwd: input.cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let buffer = '';

        const ingest = (msg: Message) => {
          result.messages.push(msg);
          if (msg.role === 'assistant') {
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
          // Bug 5: onUpdate callback exceptions must not crash dispatch.
          // Log a one-time stderr note and keep going — sibling runs are
          // isolated from this one's callback failures.
          try {
            onUpdate?.(result);
          } catch (err) {
            if (!onUpdateErrorLogged) {
              onUpdateErrorLogged = true;
              const msg2 = err instanceof Error ? err.message : String(err);
              appendStderr(`[subprocess: onUpdate callback threw: ${msg2}]\n`);
            }
          }
        };

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let event: { type?: string; message?: unknown };
          try {
            event = JSON.parse(trimmed);
          } catch {
            // Bug 7: malformed lines are tallied for a single end-of-run
            // summary; never log per-line (would itself be unbounded).
            droppedJsonlCount++;
            return;
          }
          if (event.type === 'message_end' && event.message) {
            ingest(event.message as Message);
          }
        };

        if (proc.stdout) {
          proc.stdout.on('data', (chunk: Buffer | string) => {
            const text = chunk.toString();
            // Spill active: raw bytes go to the artifact file; the
            // in-memory buffer stays capped at MAX_BUFFER_BYTES.
            if (spillPath !== null) {
              try {
                fs.appendFileSync(spillPath, text);
              } catch {
                /* best-effort: a failed spill append degrades to dropping */
              }
              return;
            }
            // Bug 2 / ADR-0002: once the line buffer exceeds the cap, stop
            // growing it and stop splitting/processing new stdout. The
            // overflow is spilled to a tmpdir artifact (when creatable) so
            // the full output is never silently lost; otherwise fall back
            // to plain truncation with a one-time stderr marker.
            if (buffer.length > MAX_BUFFER_BYTES) {
              spillPath = createSpillFile(input.agent.name);
              if (spillPath !== null) {
                result.outputFile = spillPath;
                try {
                  fs.appendFileSync(spillPath, buffer);
                } catch {
                  /* ignore */
                }
                // The crossing chunk itself must not be lost either.
                try {
                  fs.appendFileSync(spillPath, text);
                } catch {
                  /* ignore */
                }
                appendStderr(`[truncated: stdout exceeded 1MB — full output: ${spillPath}]\n`);
              } else {
                appendStderr(`[truncated: stdout exceeded 1MB]\n`);
              }
              buffer = '';
              return;
            }
            buffer += text;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) processLine(line);
          });
        }
        if (proc.stderr) {
          proc.stderr.on('data', (chunk: Buffer | string) => {
            // Bug 2: cap stderr growth at MAX_BUFFER_BYTES; drop new
            // bytes (don't grow) once we're past the threshold.
            appendStderr(chunk.toString());
          });
        }

        proc.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (buffer.trim()) processLine(buffer);
          resolve(code ?? 0);
        });
        proc.on('error', () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(1);
        });

        if (signal) {
          const onAbort = () => {
            wasAborted = true;
            proc.kill('SIGTERM');
            const sigkill = setTimeout(() => {
              if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
            }, 5000);
            sigkill.unref();
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }

        // Per-dispatch timeout beats the runner-level default. On expiry:
        // SIGTERM now, SIGKILL after 5s grace (unref'd), and the result is
        // marked timedOut so callers can distinguish timeout from user abort.
        const requested = input.timeoutMs ?? this.runTimeoutMs;
        // Defensive floor: a non-positive timeout must not silently disable
        // the kill switch (the schema enforces min 1000, but direct callers
        // of run() can bypass it).
        const effectiveTimeoutMs = requested !== undefined ? Math.max(requested, 1) : undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            didTimeOut = true;
            proc.kill('SIGTERM');
            const sigkill = setTimeout(() => {
              if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
            }, 5000);
            sigkill.unref();
            result.stopReason = 'aborted';
            result.errorMessage = `run timeout after ${effectiveTimeoutMs}ms`;
          }, effectiveTimeoutMs);
          timeoutHandle.unref();
        }
      });

      // Bug 7: surface malformed-JSONL drops as a single stderr line so
      // operators can spot a misbehaving child without filling memory.
      if (droppedJsonlCount > 0) {
        appendStderr(`[subprocess: ${droppedJsonlCount} malformed JSONL lines dropped]\n`);
      }

      result.exitCode = exitCode;
      if (didTimeOut) result.timedOut = true;
      if (wasAborted) result.stopReason = 'aborted';
      else if (exitCode !== 0 && !result.stopReason) result.stopReason = 'error';
      return result;
    } finally {
      // Bug 4: best-effort cleanup of both file and dir in one go.
      // `recursive: true` handles the non-empty-dir case (file still
      // present); `force: true` ignores ENOENT for missing entries.
      if (tmpPromptDir) {
        try {
          fs.rmSync(tmpPromptDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
}
