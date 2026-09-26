import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type * as fsType from 'node:fs';
import { SubprocessRunner, resolvePiInvocation } from '../src/runner/subprocess.js';
import {
  createProgressEmitter,
  PROGRESS_THROTTLE_MS,
  progressLine,
} from '../src/dispatch/progress.js';
import { selectRunner } from '../src/dispatch/execute.js';
import type { SingleResult, OnUpdateCallback } from '../src/types.js';

// ---------------------------------------------------------------------------
// fs mock — intercept fs.rmSync to verify tmpdir cleanup behavior. The mock
// delegates to the real implementation by default so unrelated tests pass
// without per-test configuration.
// ---------------------------------------------------------------------------
const fsMocks = vi.hoisted(() => ({
  rmSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof fsType;
  fsMocks.rmSync.mockImplementation(actual.rmSync as unknown as (...args: unknown[]) => void);
  return {
    ...actual,
    rmSync: fsMocks.rmSync,
  };
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseAgent = {
  name: 'scout',
  description: '',
  systemPrompt: '',
  source: 'bundled' as const,
  filePath: '',
};

const baseInput = { agent: baseAgent, task: 'do work', cwd: '/tmp' };

/** Minimal valid message_end line. */
const validLine = JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', content: [] },
});

// ---------------------------------------------------------------------------
// FakeChildProcess — EventEmitter that satisfies the ChildProcess surface
// the SubprocessRunner actually subscribes to (stdout/stderr data, close,
// error, kill). Methods return the wrapper itself so writes can be chained.
// ---------------------------------------------------------------------------

interface FakeProc {
  /** The raw ChildProcess-shaped object the runner sees. */
  readonly proc: ChildProcess & { kill: ReturnType<typeof vi.fn> };
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Synchronously fires `close` after kill() is called. */
  readonly killFiresClose: boolean;
  /** True once `kill` has been invoked (read-only). */
  readonly killed: boolean;
  /** Current exitCode as seen by the runner (read-only). */
  readonly exitCode: number | null;
  /** Emit `close` with a given exit code (defaults to null). */
  finish(code?: number | null): void;
  /** Push a single stdout chunk and return the wrapper for chaining. */
  writeStdout(chunk: string | Buffer): FakeProc;
  /** Push a single stderr chunk. */
  writeStderr(chunk: string | Buffer): FakeProc;
  /** End both streams (push null). Does NOT emit close. */
  endStreams(): FakeProc;
}

function makeFakeProc(opts: { killFiresClose?: boolean } = {}): FakeProc {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  };
  (proc as unknown as { stdout: Readable }).stdout = stdout;
  (proc as unknown as { stderr: Readable }).stderr = stderr;
  const state = { killed: false, exitCode: null as number | null };
  proc.kill = vi.fn(((_sig?: NodeJS.Signals) => {
    state.killed = true;
    if (opts.killFiresClose) {
      setImmediate(() => proc.emit('close', null));
    }
    return true;
  }) as unknown as typeof proc.kill);

  const self: FakeProc = {
    proc,
    stdout,
    stderr,
    killFiresClose: !!opts.killFiresClose,
    get killed() {
      return state.killed;
    },
    get exitCode() {
      return state.exitCode;
    },
    finish(code: number | null = 0) {
      stdout.push(null);
      stderr.push(null);
      state.exitCode = code;
      proc.emit('close', code);
    },
    writeStdout(chunk) {
      stdout.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return self;
    },
    writeStderr(chunk) {
      stderr.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return self;
    },
    endStreams() {
      stdout.push(null);
      stderr.push(null);
      return self;
    },
  };
  return self;
}

/**
 * Yield the event loop so pending stdout/stderr data events are drained
 * before emitting close. Without this, the runner's close handler can
 * race past the data handler and return a result that doesn't include
 * the just-pushed events.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait until the runner has attached a 'close' listener. The runner
 * subscribes inside the spawnFn promise body, which races against this
 * helper. Polling avoids the race without resorting to real timers.
 */
async function waitForCloseListener(proc: FakeProc, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (proc.proc.listenerCount('close') >= 1) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// 1. Abort mid-run
// ---------------------------------------------------------------------------

describe('SubprocessRunner.run — abort mid-run', () => {
  it('sends SIGTERM when AbortSignal fires mid-run, then reports stopReason=aborted', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const controller = new AbortController();
    const promise = runner.run(baseInput, controller.signal);

    // Wait until the runner has subscribed, then abort and let the fake
    // process close naturally (the runner's SIGTERM doesn't auto-close
    // unless killFiresClose is on; here we simulate the OS sending SIGTERM
    // by emitting close after the abort).
    await waitForCloseListener(fake);
    controller.abort();
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate the OS completing the kill by emitting close.
    fake.finish(143 /* SIGTERM exit code on POSIX */);
    const result = await promise;

    expect(result.stopReason).toBe('aborted');
    // exitCode comes from the runner's resolve(code ?? 0); SIGTERM shells
    // typically yield 143, but the runner may also see null (which becomes 0).
    expect([0, 143]).toContain(result.exitCode);
  });

  it('immediately kills an already-aborted signal without subscribing to abort', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const controller = new AbortController();
    controller.abort(); // pre-aborted
    const promise = runner.run(baseInput, controller.signal);

    await waitForCloseListener(fake);
    // The signal-aborted branch fires onAbort() synchronously; SIGTERM
    // is delivered before the runner registers any abort listener.
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');

    fake.finish(143);
    await promise;
    expect(fake.proc.kill).toHaveBeenCalledTimes(1);
  });

  it('schedules a SIGKILL grace timer after SIGTERM (timer fires; condition gates the actual call)', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeProc(); // killFiresClose=false — proc stays alive
      const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
      const controller = new AbortController();
      const promise = runner.run(baseInput, controller.signal);

      // Flush microtasks so the runner reaches its listener wiring.
      await vi.advanceTimersByTimeAsync(0);
      await waitForCloseListener(fake);

      controller.abort();
      expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');

      // Move just past the SIGKILL grace timer (5000ms). The setTimeout
      // callback runs; the runner checks `proc.exitCode === null &&
      // !proc.killed`. Our fake sets killed=true on SIGTERM, so the
      // combined check is false → SIGKILL is NOT called in the original
      // code. This negative assertion kills the `if (true)` / `||` /
      // `proc.killed` mutants (those would call SIGKILL).
      vi.advanceTimersByTime(5100);
      const killCalls = fake.proc.kill.mock.calls.map((c) => c[0]);
      expect(killCalls).not.toContain('SIGKILL');
      expect(killCalls).toEqual(['SIGTERM']);

      // Now simulate the OS finishing the (never-sent) kill so the run
      // resolves with the expected aborted state.
      vi.useRealTimers();
      fake.finish(143);
      const result = await promise;
      expect(result.stopReason).toBe('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not double-kill if proc exits within the SIGKILL grace window', async () => {
    const fake = makeFakeProc({ killFiresClose: true });
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const controller = new AbortController();
    const promise = runner.run(baseInput, controller.signal);

    await waitForCloseListener(fake);
    controller.abort();
    // SIGTERM fired; killFiresClose schedules a close → the runner settles.
    // Wait for that scheduled close to fire and the promise to resolve.
    const result = await promise;

    // SIGKILL should NOT be called because proc.exitCode became non-null
    // by the time the grace timer would fire (the close happened first).
    expect(fake.proc.kill).toHaveBeenCalledTimes(1);
    expect(fake.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.stopReason).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// 2. fs cleanup on error (tmpdir recursive rm)
// ---------------------------------------------------------------------------

describe('SubprocessRunner.run — fs cleanup on error paths', () => {
  /**
   * Wrap the real writePromptFile so the spawned promise's tmpdir is
   * tracked even when the runner's own finally runs. We don't mock fs
   * directly — instead we feed the runner an input with a system prompt
   * and assert that the resulting tmpdir is removed.
   */
  it('removes tmpdir via fs.rmSync(recursive, force) after a successful run with a system prompt', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    fsMocks.rmSync.mockClear();
    const promise = runner.run({
      ...baseInput,
      agent: { ...baseAgent, systemPrompt: 'You are a scout.' },
    });

    await waitForCloseListener(fake);
    fake.writeStdout(validLine + '\n');
    await tick();
    fake.finish(0);
    const result = await promise;

    // The runner must have called fs.rmSync at least once with
    // recursive: true and force: true.
    const rmCalls = fsMocks.rmSync.mock.calls.filter(
      (c) =>
        typeof c[1] === 'object' &&
        c[1] !== null &&
        (c[1] as { recursive?: boolean }).recursive === true &&
        (c[1] as { force?: boolean }).force === true,
    );
    expect(rmCalls.length).toBeGreaterThan(0);
    // The actual tmpdir for the agent's prompt file must have been passed
    // in (the path matches the prefix writePromptFile uses).
    const path = rmCalls[0][0] as string;
    expect(path).toMatch(/pi-subagent-/);
    expect(result.exitCode).toBe(0);
  });

  it('still calls fs.rmSync(recursive, force) when the subprocess errors out (uncaught throw)', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    fsMocks.rmSync.mockClear();
    const promise = runner.run({
      ...baseInput,
      agent: { ...baseAgent, systemPrompt: 'You are a scout.' },
    });

    await waitForCloseListener(fake);
    // Simulate the process erroring before close fires.
    fake.proc.emit('error', new Error('spawn failed'));
    fake.endStreams();
    await tick();
    // The 'error' handler in run() resolves with exitCode 1.
    const result = await promise;

    expect(result.exitCode).toBe(1);
    // fs.rmSync must still have been called with recursive+force in the
    // finally block.
    const rmCalls = fsMocks.rmSync.mock.calls.filter(
      (c) =>
        typeof c[1] === 'object' &&
        c[1] !== null &&
        (c[1] as { recursive?: boolean }).recursive === true &&
        (c[1] as { force?: boolean }).force === true,
    );
    expect(rmCalls.length).toBeGreaterThan(0);
  });

  it('still calls fs.rmSync(recursive, force) when stderr buffer overflows (>1MB)', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    fsMocks.rmSync.mockClear();
    const promise = runner.run({
      ...baseInput,
      agent: { ...baseAgent, systemPrompt: 'You are a scout.' },
    });

    await waitForCloseListener(fake);
    // Push > 1MB to stderr to overflow the cap. Chunk into a few writes
    // so the stream drain can interleave with the runner's data handler.
    const big = 'y'.repeat(400 * 1024); // 400KB
    fake.writeStderr(big).writeStderr(big).writeStderr(big);
    fake.endStreams();
    await tick();
    fake.finish(0);
    const result = await promise;

    // The stderr buffer should be capped at exactly MAX_BUFFER_BYTES.
    expect(result.stderr.length).toBeLessThanOrEqual(1024 * 1024);
    expect(result.stderr.length).toBe(1024 * 1024);
    // Cleanup still ran.
    const rmCalls = fsMocks.rmSync.mock.calls.filter(
      (c) =>
        typeof c[1] === 'object' &&
        c[1] !== null &&
        (c[1] as { recursive?: boolean }).recursive === true &&
        (c[1] as { force?: boolean }).force === true,
    );
    expect(rmCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. JSONL streaming + onUpdate shape
// ---------------------------------------------------------------------------

describe('SubprocessRunner.run — JSONL streaming partial results', () => {
  it('invokes onUpdate with each new message_end event in order', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const seen: number[] = [];
    const onUpdate = vi.fn((partial: SingleResult) => {
      seen.push(partial.messages.length);
    });

    const events = [
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'toolResult', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
    ];
    const stream = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    const promise = runner.run(baseInput, undefined, onUpdate);
    await waitForCloseListener(fake);
    fake.writeStdout(stream);
    await tick();
    fake.finish(0);
    const result = await promise;

    expect(result.messages).toHaveLength(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it('continues streaming JSONL events emitted after an abort signal fires (data delivered before close)', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const controller = new AbortController();
    const onUpdate = vi.fn();
    const events = [
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
    ];
    const stream = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    const promise = runner.run(baseInput, controller.signal, onUpdate);

    await waitForCloseListener(fake);
    // Emit two JSONL events BEFORE aborting — they should still land in
    // the partial result.
    fake.writeStdout(stream);
    await tick();
    controller.abort();
    fake.finish(143);

    const result = await promise;
    expect(result.messages).toHaveLength(2);
    expect(result.stopReason).toBe('aborted');
    // onUpdate should have been called for each ingested event.
    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('appends a one-time malformed JSONL summary to stderr when lines fail to parse', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const stream =
      [validLine, '{not json', validLine, '{also bad', '{also bad 2'].join('\n') + '\n';

    const promise = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout(stream);
    await tick();
    fake.finish(0);
    const result = await promise;

    expect(result.messages).toHaveLength(2);
    expect(result.stderr).toContain('[subprocess: 3 malformed JSONL lines dropped]');
  });
});

// ---------------------------------------------------------------------------
// 4. onUpdate exception isolation
// ---------------------------------------------------------------------------

describe('SubprocessRunner.run — onUpdate exception isolation', () => {
  it('does not crash the run when onUpdate throws — logs a single stderr note and continues', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    let calls = 0;
    const onUpdate = vi.fn(() => {
      calls += 1;
      if (calls === 2) throw new Error('callback boom');
    });

    const events = [
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
    ];
    const stream = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    const promise = runner.run(baseInput, undefined, onUpdate);
    await waitForCloseListener(fake);
    fake.writeStdout(stream);
    await tick();
    fake.finish(0);
    const result = await promise;

    expect(onUpdate).toHaveBeenCalledTimes(3);
    // The 3rd call still fired even though the 2nd threw — isolation works.
    expect(calls).toBe(3);
    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(3);
    // The stderr note names the original error message verbatim.
    expect(result.stderr).toContain('onUpdate callback threw: callback boom');
  });

  it('logs the onUpdate error only ONCE even when many subsequent events fire it', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const onUpdate = vi.fn(() => {
      throw new Error('always fails');
    });

    // 5 events; the first one triggers the throw; stderr must log it once.
    const events = Array.from({ length: 5 }, () => ({
      type: 'message_end',
      message: { role: 'assistant', content: [] },
    }));
    const stream = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    const promise = runner.run(baseInput, undefined, onUpdate);
    await waitForCloseListener(fake);
    fake.writeStdout(stream);
    await tick();
    fake.finish(0);
    const result = await promise;

    expect(onUpdate).toHaveBeenCalledTimes(5);
    const occurrences = (result.stderr.match(/onUpdate callback threw/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. stdout buffer cap (1 MB)
// ---------------------------------------------------------------------------

describe('SubprocessRunner.run — stdout 1MB buffer cap', () => {
  it('drops further stdout after the line buffer exceeds 1MB and appends a single truncation marker', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    // Two valid lines first (must survive), then a >1MB no-newline blob
    // (overflows the buffer and triggers truncation), then two more lines
    // (must be DROPPED). The runner checks `buffer.length > MAX_BUFFER_BYTES`
    // at the start of EACH data event, so we must push in chunks (the
    // 2nd chunk fills the buffer past 1MB; the 3rd triggers truncation).
    const padding = 'x'.repeat(2 * 1024 * 1024);

    const promise = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout(validLine + '\n' + validLine + '\n');
    await tick();
    fake.writeStdout(padding);
    await tick();
    fake.writeStdout(validLine + '\n' + validLine + '\n');
    await tick();
    fake.finish(0);
    const result = await promise;

    // Truncation marker appears exactly once.
    expect(result.stderr).toMatch(/\[truncated: stdout exceeded 1MB — full output: .+\.log\]/);
    expect((result.stderr.match(/truncated: stdout exceeded 1MB/g) ?? []).length).toBe(1);
    // Only the first two valid lines (pre-overflow) survive.
    expect(result.messages).toHaveLength(2);
  });

  it('keeps stderr growth capped at MAX_BUFFER_BYTES (1MB) and stops appending past it', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });

    const promise = runner.run(baseInput);
    await waitForCloseListener(fake);

    // Push 2MB to stderr in 256KB chunks — must clamp to exactly 1MB.
    const chunk = 'y'.repeat(256 * 1024);
    fake.writeStderr(chunk).writeStderr(chunk).writeStderr(chunk).writeStderr(chunk);
    fake.endStreams();
    await tick();
    fake.finish(0);
    const result = await promise;

    expect(result.stderr.length).toBe(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 6. progress.ts no-coverage mutants (progressLine + createProgressEmitter)
// ---------------------------------------------------------------------------

describe('progressLine (no-coverage mutants in dispatch/progress.ts)', () => {
  const doneResult: SingleResult = {
    agent: 'a',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    messages: [] as unknown as SingleResult['messages'],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    running: false,
  };
  const runningResult: SingleResult = {
    ...doneResult,
    running: true,
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ] as unknown as SingleResult['messages'],
  };
  const failedResult: SingleResult = { ...doneResult, exitCode: 1 };

  it("returns 'Running…' when single-mode results array is empty", () => {
    expect(progressLine('single', [], 1)).toBe('Running…');
  });

  it('emits "<agent>: done" verbatim when single-mode result is settled', () => {
    expect(progressLine('single', [doneResult], 1)).toBe('a: done');
  });

  it('parallel header pluralizes "subagents" when total !== 1', () => {
    expect(progressLine('parallel', [runningResult], 3)).toContain('Running 3 subagents…');
    expect(progressLine('parallel', [runningResult], 3)).toContain('(0/3 done)');
  });

  it('parallel header singularizes "subagent" when total === 1', () => {
    expect(progressLine('parallel', [runningResult], 1)).toContain('Running 1 subagent…');
    expect(progressLine('parallel', [runningResult], 1)).not.toContain('subagents');
  });

  it('parallel failed tag uses " failed" verbatim (string-literal mutant target)', () => {
    const line = progressLine('parallel', [failedResult], 1);
    expect(line).toContain(' failed');
    expect(line).toContain('✗');
  });

  it('chain returns "Step 0/N: starting…" when results array is empty', () => {
    expect(progressLine('chain', [], 3)).toBe('Step 0/3: starting…');
  });
});

describe('createProgressEmitter — coalesce trailing edge (no-coverage mutants)', () => {
  /** Build a minimal ProgressPayload for testing. */
  const payload = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: {
      mode: 'single' as const,
      agentScope: 'user' as const,
      projectAgentsDir: null,
      results: [],
    },
  });

  it('coalesces rapid-fire payloads into a single trailing emit when within the throttle window', () => {
    vi.useFakeTimers();
    try {
      const calls: unknown[] = [];
      const sink: OnUpdateCallback = (p) => {
        calls.push(p);
      };
      const emit = createProgressEmitter(sink, PROGRESS_THROTTLE_MS);
      expect(emit).toBeDefined();

      // First emit fires immediately.
      emit!(payload('first'));
      expect(calls).toHaveLength(1);

      // Subsequent emits within the window must NOT fire immediately —
      // they coalesce into a trailing timer.
      emit!(payload('second'));
      emit!(payload('third'));
      expect(calls).toHaveLength(1);

      // Advance to just past the trailing edge — exactly ONE more emit
      // (the latest payload) must fire.
      vi.advanceTimersByTime(PROGRESS_THROTTLE_MS + 1);
      expect(calls).toHaveLength(2);
      // The trailing emit carries the LATEST payload, not the first
      // coalesced one.
      const last = calls[1] as { content: Array<{ text: string }> };
      expect(last.content[0].text).toBe('third');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined when onUpdate is not provided (no-op emitter)', () => {
    expect(createProgressEmitter(undefined)).toBeUndefined();
  });

  it('fires back-to-back without coalescing once each emit lands outside the throttle window', () => {
    vi.useFakeTimers();
    try {
      const calls: unknown[] = [];
      const sink: OnUpdateCallback = (p) => {
        calls.push(p);
      };
      const emit = createProgressEmitter(sink, PROGRESS_THROTTLE_MS);
      emit!(payload('a'));
      vi.advanceTimersByTime(PROGRESS_THROTTLE_MS + 5);
      emit!(payload('b'));
      vi.advanceTimersByTime(PROGRESS_THROTTLE_MS + 5);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. selectRunner (dispatch/execute.ts) and resolvePiInvocation
// `isGenericRuntime === false` branch — the last two no-cov mutants in
// src/dispatch/* and src/runner/subprocess/invocation.ts.
// ---------------------------------------------------------------------------

describe('selectRunner', () => {
  it('returns a SubprocessRunner instance with id="subprocess"', () => {
    const runner = selectRunner();
    expect(runner.id).toBe('subprocess');
  });
});

describe('resolvePiInvocation — non-generic runtime branch', () => {
  it('returns { command: process.execPath, args } when exec basename is not node/bun', () => {
    const originalExec = process.execPath;
    const originalArgv = process.argv[1];
    try {
      // Force both the argv branch to be skipped AND the isGenericRuntime
      // check to fail so we land in the third return statement.
      process.argv[1] = '/nonexistent/path/to/script.ts';
      process.execPath = '/usr/local/bin/my-custom-runtime';
      const result = resolvePiInvocation(['--mode', 'json']);
      expect(result.command).toBe('/usr/local/bin/my-custom-runtime');
      expect(result.args).toEqual(['--mode', 'json']);
    } finally {
      process.execPath = originalExec;
      process.argv[1] = originalArgv;
    }
  });
});
