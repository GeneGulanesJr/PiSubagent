import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import { emitCloseSticky, waitForCloseListener } from './helpers/fake-close.js';

const baseInput = {
  agent: {
    name: 'scout',
    description: '',
    systemPrompt: '',
    source: 'bundled' as const,
    filePath: '',
  },
  task: 'do work',
  cwd: '/tmp',
};

function makeFakeProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdout: Readable;
    stderr: Readable;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => true) as never;
  const finish = (code: number | null = 0) => {
    stdout.push(null);
    stderr.push(null);
    // A real child process emits 'close' only after its stdio streams are
    // fully drained; defer accordingly so the runner's async stdout
    // consumer flushes before the run finalizes (same pattern as
    // test/spill.test.ts). Emitting 'close' synchronously races the
    // stream machinery and the spill handler never runs.
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      emitCloseSticky(proc, code);
    };
    stdout.on('end', close);
    stderr.on('end', close);
    let ticks = 0;
    const tick = () => {
      if (closed) return;
      ticks += 1;
      if (ticks > 1000) close();
      else setImmediate(tick);
    };
    setImmediate(tick);
  };
  return { proc, finish };
}

describe('SubprocessRunner — spill fallback (spillFactory injection)', () => {
  it('factory returning null → plain truncation fallback', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({
      spawnFn: (() => fake.proc) as never,
      spillFactory: () => null,
    });
    const p = runner.run(baseInput);
    await waitForCloseListener(fake.proc);
    fake.proc.stdout.push(Buffer.from('a'.repeat(1100 * 1024)));
    fake.proc.stdout.push(Buffer.from('b'.repeat(64)));
    fake.finish(0);
    const r = await p;
    expect(r.outputFile).toBeUndefined();
    expect(r.stderr).toContain('[truncated: stdout exceeded 1MB]');
    expect(r.stderr).not.toContain('full output:');
  });

  it('factory receiving agent name', async () => {
    const fake = makeFakeProc();
    const seen: string[] = [];
    const runner = new SubprocessRunner({
      spawnFn: (() => fake.proc) as never,
      spillFactory: (n) => {
        seen.push(n);
        return null;
      },
    });
    const p = runner.run(baseInput);
    await waitForCloseListener(fake.proc);
    fake.proc.stdout.push(Buffer.from('a'.repeat(1100 * 1024)));
    fake.proc.stdout.push(Buffer.from('b'.repeat(64)));
    fake.finish(0);
    await p;
    expect(seen).toEqual(['scout']);
  });

  it('custom factory path is honored', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({
      spawnFn: (() => fake.proc) as never,
      spillFactory: () => '/tmp/fake-spill.log',
    });
    const p = runner.run(baseInput);
    await waitForCloseListener(fake.proc);
    fake.proc.stdout.push(Buffer.from('a'.repeat(1100 * 1024)));
    fake.proc.stdout.push(Buffer.from('b'.repeat(64)));
    fake.finish(0);
    const r = await p;
    expect(r.outputFile).toBe('/tmp/fake-spill.log');
    expect(r.stderr).toContain('full output: /tmp/fake-spill.log');
    // The spill artifact never needs to exist — appendFileSync failures are
    // best-effort. The run must still complete cleanly.
    expect(r.exitCode).toBeDefined();
    expect(r.messages.length).toBeGreaterThanOrEqual(0);
  });
});
