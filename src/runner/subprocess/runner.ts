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
import { resolveRunModel } from '../../tier.js';

/** Hard cap on stdout line buffer / stderr accumulator per run (1 MB). */
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Bounded dead-letter capture for malformed JSONL stdout lines (issue #2).
 * Keeps WHAT dropped — not just how much — but the capture is capped and
 * each line clipped, so a garbage fire can't OOM the parent (same
 * discipline as the Bug 2 / Bug 7 stderr caps).
 */
const MAX_MALFORMED_CAPTURED = 20;
const MAX_MALFORMED_LINE_CHARS = 200;

/**
 * Launch-phase retry (issue #2): a child that dies at spawn/launch — a
 * spawn `error` event (ENOMEM, EAGAIN, …) or an instant non-zero exit with
 * zero agent output — is retried with exponential backoff and jitter
 * (base ×2 per attempt). A run that produced any `message_end` event, that
 * lived past LAUNCH_FAILURE_WINDOW_MS, that was aborted or timed out, or
 * that exited 0 is a real outcome and is never retried here (the outer
 * runWithRetries still applies on top).
 */
const MAX_LAUNCH_RETRIES = 3;
const LAUNCH_FAILURE_WINDOW_MS = 100;

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
   * after 5s) and the run is finalized with `stopReason: "timeout"` and
   * `errorMessage: "run timeout after Xms"`. Default: no timeout.
   */
  runTimeoutMs?: number;
  /**
   * Injectable spill-file factory for tests; defaults to createSpillFile.
   * Return null to simulate tmpdir failure and exercise the plain-truncation
   * fallback path.
   */
  spillFactory?: (agentName: string) => string | null;
  /**
   * Base backoff in ms for launch-phase retries (1s, 2s, 4s ×±20% jitter at
   * the default). Tests inject a small value. 0 disables launch retrying.
   */
  launchRetryBaseMs?: number;
}

export class SubprocessRunner implements AgentRunner {
  readonly id = 'subprocess' as const;
  private readonly spawnFn: typeof spawn;
  private readonly runTimeoutMs?: number;
  private readonly spillFactory: (agentName: string) => string | null;
  private readonly launchRetryBaseMs: number;

  constructor(options: SubprocessRunnerOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.runTimeoutMs = options.runTimeoutMs;
    this.spillFactory = options.spillFactory ?? createSpillFile;
    this.launchRetryBaseMs = options.launchRetryBaseMs ?? 1_000;
  }

  /**
   * Pure CLI-flag prefix composition. Order is stable for tests:
   * --mode json -p [--session S | --session-id I | --no-session] [--model M] ...
   * (run() appends [--append-system-prompt tmp] and the Task: line afterwards.)
   *
   * Model resolution (most specific wins, see src/tier.ts): per-dispatch
   * `model` override → per-dispatch `tier` → agent frontmatter `model:` →
   * agent frontmatter `tier:` → parent inheritance.
   *
   * Thinking level resolution (most specific wins): per-dispatch override →
   * agent frontmatter → tier default (tier-routed runs; cheap: medium,
   * thinking: high) → parent inheritance (only when the agent inherits the
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
    if (input.sessionDir) args.push('--session-dir', input.sessionDir);
    const resolved = resolveRunModel(input.agent, {
      modelOverride: input.modelOverride,
      tierOverride: input.tierOverride,
    });
    const model = resolved.model ?? dispatchDefaults.parentModel;
    if (model) args.push('--model', model);
    const thinking = resolveThinkingLevel(input.agent, {
      thinkingLevelOverride: input.thinkingLevelOverride,
      parentThinkingLevel: dispatchDefaults.parentThinkingLevel,
      tier: resolved.tier,
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
    const resolved = resolveRunModel(input.agent, {
      modelOverride: input.modelOverride,
      tierOverride: input.tierOverride,
    });
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
      tier: resolved.tier,
    });

    const result: SingleResult = {
      agent: input.agent.name,
      agentSource: input.agent.source === 'bundled' ? 'user' : input.agent.source,
      task: input.task,
      exitCode: 0,
      messages: [],
      stderr: '',
      usage: emptyUsage(),
      model: resolved.model ?? input.parentModel,
      tier: resolved.tier,
      thinkingLevel,
      sessionId,
    };

    let tmpPromptDir: string | null = null;
    let wasAborted = false;
    let didTimeOut = false;
    let malformedLineCount = 0;
    let jsonlLineNo = 0;
    const malformedOutput: string[] = [];
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

      let launchRetries = 0;

      const exitCode = await new Promise<number>((resolve) => {
        // Per-attempt launch state, reset by attemptLaunch on each retry.
        let spawnFailed = false;
        let sawAgentOutput = false;
        let startedAt = 0;
        let attemptSettled = false;

        // Launch-retry decision point (issue #2), called when an attempt
        // ends via close or error. Only genuine launch failures retry: a
        // spawn `error` event, or a non-zero exit inside the launch window
        // that produced zero agent output. Real output, success, aborts,
        // and timeouts are final — the outer runWithRetries can still
        // retry the failed result on top of whatever this returns.
        const finishAttempt = (code: number) => {
          const diedInLaunchWindow = Date.now() - startedAt < LAUNCH_FAILURE_WINDOW_MS;
          const launchFailed = spawnFailed || (diedInLaunchWindow && !sawAgentOutput);
          const eligible =
            code !== 0 &&
            launchFailed &&
            !wasAborted &&
            !didTimeOut &&
            launchRetries < MAX_LAUNCH_RETRIES &&
            !signal?.aborted &&
            // launchRetryBaseMs 0 = launch retrying disabled (tests, and any
            // caller that wants spawn errors to fail fast).
            this.launchRetryBaseMs > 0;
          if (!eligible) {
            resolve(code);
            return;
          }
          launchRetries += 1;
          // Exponential backoff (1s, 2s, 4s at the default base) with ±20%
          // jitter so sibling dispatches don't retry in lockstep.
          const jitter = 0.8 + Math.random() * 0.4;
          const delay = Math.round(this.launchRetryBaseMs * 2 ** (launchRetries - 1) * jitter);
          appendStderr(
            `[subprocess: launch failure (retry ${launchRetries}/${MAX_LAUNCH_RETRIES}) — relaunching in ${delay}ms]\n`,
          );
          const t = setTimeout(() => {
            if (signal?.aborted) {
              // User cut it off between attempts — record intent, don't relaunch.
              wasAborted = true;
              resolve(code);
              return;
            }
            attemptLaunch();
          }, delay);
          t.unref();
        };

        const attemptLaunch = (): void => {
          spawnFailed = false;
          sawAgentOutput = false;
          startedAt = Date.now();
          attemptSettled = false;
          const invocation = resolvePiInvocation(args);
          const proc: ChildProcess = this.spawnFn(invocation.command, invocation.args, {
            cwd: input.cwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let buffer = '';
          let timeoutHandle: NodeJS.Timeout | undefined;

          // One decision per attempt: a failed spawn can emit both 'error'
          // and 'close' depending on the failure mode.
          const settle = (code: number) => {
            if (attemptSettled) return;
            attemptSettled = true;
            finishAttempt(code);
          };

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
            jsonlLineNo++;
            const trimmed = line.trim();
            if (!trimmed) return;
            let event: { type?: string; message?: unknown };
            try {
              event = JSON.parse(trimmed);
            } catch {
              // Bug 7 + issue #2: tally every drop for the single end-of-run
              // summary, and capture (bounded, with the 1-based line offset)
              // the first offenders so the misbehaving child can be diagnosed
              // from result.malformedOutput alone.
              malformedLineCount++;
              if (malformedOutput.length < MAX_MALFORMED_CAPTURED) {
                const clipped =
                  trimmed.length > MAX_MALFORMED_LINE_CHARS
                    ? `${trimmed.slice(0, MAX_MALFORMED_LINE_CHARS)}…`
                    : trimmed;
                malformedOutput.push(`line ${jsonlLineNo}: ${clipped}`);
              }
              return;
            }
            if (event.type === 'message_end' && event.message) {
              // Any agent output means the launch itself succeeded — this
              // attempt can no longer be launch-retried.
              sawAgentOutput = true;
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
                spillPath = this.spillFactory(input.agent.name);
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
            settle(code ?? 0);
          });
          proc.on('error', () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            spawnFailed = true;
            settle(1);
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
          // SIGTERM now, SIGKILL after 5s grace (unref'd), and the result gets
          // `stopReason: 'timeout'` plus `timedOut: true` — unless the user
          // also aborts, in which case `wasAborted` wins the stopReason (user
          // intent) while `timedOut` stays set for the record.
          const requested = input.timeoutMs ?? this.runTimeoutMs;
          // Defensive floor: a non-positive timeout must not silently disable
          // the kill switch (the schema enforces min 1000, but direct callers
          // of run() can bypass it).
          const effectiveTimeoutMs = requested !== undefined ? Math.max(requested, 1) : undefined;
          if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
              didTimeOut = true;
              proc.kill('SIGTERM');
              const sigkill = setTimeout(() => {
                if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
              }, 5000);
              sigkill.unref();
              result.stopReason = 'timeout';
              result.errorMessage = `run timeout after ${effectiveTimeoutMs}ms`;
            }, effectiveTimeoutMs);
            timeoutHandle.unref();
          }
        };

        attemptLaunch();
      });

      // Issue #2: report launch-phase retries so callers can tell a flaky
      // launch from a clean run.
      if (launchRetries > 0) {
        result.launchRetries = launchRetries;
        appendStderr(`[subprocess: recovered after ${launchRetries} launch retry(ies)]\n`);
      }

      // Bug 7: surface malformed-JSONL drops as a single stderr line so
      // operators can spot a misbehaving child without filling memory.
      // Issue #2: attach the bounded dead-letter capture to the result too.
      if (malformedLineCount > 0) {
        result.malformedOutput = malformedOutput;
        appendStderr(`[subprocess: ${malformedLineCount} malformed JSONL lines dropped]\n`);
        const captured = malformedOutput.map((l) => l.replace(/\n/g, '\\n')).join(' | ');
        appendStderr(
          `[subprocess: malformed capture (first ${malformedOutput.length} of ${malformedLineCount}): ${captured}]\n`,
        );
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
