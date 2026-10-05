import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { emitCloseSticky, waitForCloseListener } from './helpers/fake-close.js';

/**
 * Issue #2 part 2 — launch-phase retry: a child that dies at spawn (error
 * event) or instantly with zero agent output is retried with exponential
 * backoff + jitter; real output, past-the-window exits, aborts, and
 * timeouts are never retried.
 */

const baseAgent = {
  name: 'scout',
  description: '',
  systemPrompt: '',
  source: 'bundled' as const,
  filePath: '',
};
const baseInput = { agent: baseAgent, task: 'x', cwd: '/tmp' };
const validLine = JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SpawnMock = { mock: { results: Array<{ value: unknown }> } };

/** Wait for the nth spawn call to have happened, then return its proc. */
async function nthSpawnProc(spawn: SpawnMock, i: number): Promise<ReturnType<typeof makeFakeProc>> {
  while (spawn.mock.results.length <= i) await sleep(2);
  return spawn.mock.results[i].value as ReturnType<typeof makeFakeProc>;
}

function makeFakeProc(): ChildProcess & { stdout: Readable; stderr: Readable } {
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdout: Readable;
    stderr: Readable;
    killed: boolean;
    exitCode: number | null;
    kill: (sig?: NodeJS.Signals) => boolean;
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  return proc;
}

/** End streams, let buffered 'data' drain, then emit close (sticky). */
async function finishProc(
  proc: ChildProcess & { stdout: Readable; stderr: Readable },
  stdoutChunks: string[],
  closeCode: number | null,
): Promise<void> {
  await waitForCloseListener(proc);
  for (const c of stdoutChunks) proc.stdout.push(c);
  proc.stdout.push(null);
  proc.stderr.push(null);
  await new Promise((resolve) => setImmediate(resolve));
  emitCloseSticky(proc, closeCode);
}

describe('launch-phase retry (issue #2)', () => {
  it('retries an instant exit 137 and succeeds on the relaunch', async () => {
    const dead = makeFakeProc();
    const good = makeFakeProc();
    const procs = [dead, good];
    const spawn = vi.fn(() => procs.shift() ?? good);
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });

    const promise = runner.run(baseInput);
    await finishProc(dead, [], 137);
    await finishProc(good, [validLine + '\n'], 0);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.launchRetries).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result.stderr).toContain('launch failure (retry 1/3)');
    expect(result.stderr).toContain('recovered after 1 launch retry');
  });

  it('retries up to 3 times then succeeds on the 4th launch', async () => {
    const spawn = vi.fn(() => makeFakeProc());
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });

    const promise = runner.run(baseInput);
    for (let i = 0; i < 3; i++) {
      await finishProc(await nthSpawnProc(spawn, i), [], 137);
    }
    await finishProc(await nthSpawnProc(spawn, 3), [validLine + '\n'], 0);
    const result = await promise;

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(result.exitCode).toBe(0);
    expect(result.launchRetries).toBe(3);
    expect(result.messages).toHaveLength(1);
  });

  it('gives up after 3 launch retries and reports the last failure', async () => {
    const spawn = vi.fn(() => makeFakeProc());
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });

    const promise = runner.run(baseInput);
    for (let i = 0; i < 4; i++) {
      await finishProc(await nthSpawnProc(spawn, i), [], 137);
    }
    const result = await promise;

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(result.exitCode).toBe(137);
    expect(result.launchRetries).toBe(3);
    expect(result.stopReason).toBe('error');
  });

  it('does not retry an exit that lands after the launch window', async () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });

    const promise = runner.run(baseInput);
    await sleep(130); // past LAUNCH_FAILURE_WINDOW_MS (100ms)
    await finishProc(proc, [], 137);
    const result = await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(137);
    expect('launchRetries' in result).toBe(false);
  });

  it('does not retry when the agent produced real output before failing', async () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });

    const promise = runner.run(baseInput);
    await finishProc(proc, [validLine + '\n'], 1);
    const result = await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect('launchRetries' in result).toBe(false);
  });

  it('retries a spawn error event (ENOMEM/EAGAIN class)', async () => {
    const dead = makeFakeProc();
    const good = makeFakeProc();
    const procs = [dead, good];
    const spawn = vi.fn(() => procs.shift() ?? good);
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });

    const promise = runner.run(baseInput);
    await waitForCloseListener(dead);
    dead.emit('error', new Error('spawn EAGAIN'));
    await finishProc(good, [validLine + '\n'], 0);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.launchRetries).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('never relaunches after the user aborts', async () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const runner = new SubprocessRunner({ spawnFn: spawn as never, launchRetryBaseMs: 1 });
    const controller = new AbortController();

    const promise = runner.run(baseInput, controller.signal);
    controller.abort();
    await finishProc(proc, [], 137);
    const result = await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('aborted');
    expect('launchRetries' in result).toBe(false);
  });
});
