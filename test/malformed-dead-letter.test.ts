import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { emitCloseSticky } from './helpers/fake-close.js';

/**
 * Issue #2 part 3 — malformed-JSONL dead-letter capture: dropped lines are
 * captured (bounded, with line offsets) on result.malformedOutput and
 * summarized on stderr, while valid lines still ingest normally.
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

/** Minimal ChildProcess fake — same shape as runner-subprocess.test.ts's. */
function makeFakeProc(): ChildProcess {
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

/** Push chunks, end the streams, emit close once the runner is listening. */
async function emit(
  proc: ChildProcess,
  stdoutChunks: string[],
  closeCode: number | null = 0,
): Promise<void> {
  const stdout = (proc as unknown as { stdout: Readable }).stdout;
  const stderr = (proc as unknown as { stderr: Readable }).stderr;
  proc.once('close', () => undefined);
  for (const c of stdoutChunks) stdout.push(c);
  stdout.push(null);
  stderr.push(null);
  const start = Date.now();
  while ((proc as unknown as EventEmitter).listenerCount('close') < 2) {
    if (Date.now() - start > 5000) throw new Error('runner never subscribed to close');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // At least one macrotask hop so the buffered 'data' events (nextTick)
  // drain before close lands — same bridge as runner-subprocess.test.ts.
  await new Promise((resolve) => setImmediate(resolve));
  emitCloseSticky(proc, closeCode);
}

describe('malformed-JSONL dead-letter capture (issue #2)', () => {
  it('captures the garbage line with its offset between valid lines', async () => {
    const proc = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => proc) as never });
    const promise = runner.run(baseInput);
    await emit(proc, [
      [validLine, '{not json 1', validLine].join('\n') + '\n',
    ]);
    const result = await promise;

    expect(result.messages).toHaveLength(2);
    expect(result.malformedOutput).toEqual(['line 2: {not json 1']);
    expect(result.stderr).toContain('[subprocess: 1 malformed JSONL lines dropped]');
    expect(result.stderr).toContain(
      '[subprocess: malformed capture (first 1 of 1): line 2: {not json 1]',
    );
  });

  it('advances the offset across blank lines without counting them as malformed', async () => {
    const proc = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => proc) as never });
    const promise = runner.run(baseInput);
    await emit(proc, [`${validLine}\n\n\n{bad\n`]);
    const result = await promise;

    expect(result.messages).toHaveLength(1);
    expect(result.malformedOutput).toEqual(['line 4: {bad']);
  });

  it('clips over-long garbage lines and records the whole-line offset', async () => {
    const proc = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => proc) as never });
    const garbage = 'x'.repeat(500);
    const promise = runner.run(baseInput);
    await emit(proc, [`{${garbage}\n`]);
    const result = await promise;

    expect(result.malformedOutput).toHaveLength(1);
    const entry = result.malformedOutput![0];
    expect(entry.startsWith('line 1: {')).toBe(true);
    expect(entry).toContain('…');
    expect(entry.length).toBeLessThan(220);
  });

  it('caps the capture while still reporting the true drop count', async () => {
    const proc = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => proc) as never });
    const lines = Array.from({ length: 30 }, (_, i) => `{bad ${i}`).join('\n') + '\n';
    const promise = runner.run(baseInput);
    await emit(proc, [lines]);
    const result = await promise;

    expect(result.malformedOutput).toHaveLength(20);
    expect(result.malformedOutput![0]).toBe('line 1: {bad 0');
    expect(result.malformedOutput![19]).toBe('line 20: {bad 19');
    expect(result.stderr).toContain('[subprocess: 30 malformed JSONL lines dropped]');
    expect(result.stderr).toContain(
      '[subprocess: malformed capture (first 20 of 30): line 1: {bad 0 |',
    );
  });

  it('leaves malformedOutput absent when nothing was dropped', async () => {
    const proc = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => proc) as never });
    const promise = runner.run(baseInput);
    await emit(proc, [`${validLine}\n`]);
    const result = await promise;

    expect('malformedOutput' in result).toBe(false);
    expect(result.stderr).not.toContain('malformed');
  });
});
