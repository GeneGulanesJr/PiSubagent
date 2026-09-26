import { describe, it, expect, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { SubprocessRunner } from '../src/runner/subprocess.js';
import type { SingleResult } from '../src/types.js';

const baseAgent = {
  name: 'scout',
  description: '',
  systemPrompt: '',
  source: 'bundled' as const,
  filePath: '',
};
const baseInput = { agent: baseAgent, task: 'do work', cwd: '/tmp' };

interface FakeProc {
  proc: ChildProcess & { kill: ReturnType<typeof vi.fn> };
  stdout: Readable;
  stderr: Readable;
  readonly killed: boolean;
  finish(code?: number | null): void;
  writeStdout(s: string): FakeProc;
  writeStderr(s: string): FakeProc;
}

function makeFakeProc(): FakeProc {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  (proc as unknown as { stdout: Readable }).stdout = stdout;
  (proc as unknown as { stderr: Readable }).stderr = stderr;
  const state = { killed: false };
  proc.kill = vi.fn((() => {
    state.killed = true;
    return true;
  }) as never);
  const self: FakeProc = {
    proc,
    stdout,
    stderr,
    get killed() {
      return state.killed;
    },
    finish(code: number | null = 0) {
      stdout.push(null);
      stderr.push(null);
      // A real child process emits 'close' only after its stdio streams are
      // fully drained; defer accordingly so the runner's async stdout
      // consumer can flush before the run finalizes.
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        proc.emit('close', code);
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
    },
    writeStdout(s: string) {
      stdout.push(Buffer.from(s));
      return self;
    },
    writeStderr(s: string) {
      stderr.push(Buffer.from(s));
      return self;
    },
  };
  return self;
}

async function waitForCloseListener(
  proc: ReturnType<typeof makeFakeProc>,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (proc.proc.listenerCount('close') >= 1) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const spillDirs: string[] = [];
afterAll(() => {
  for (const d of spillDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('SubprocessRunner.run — stdout spill', () => {
  it('under cap — no spill', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p: Promise<SingleResult> = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout(
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [] } }) + '\n',
    );
    fake.finish(0);
    const r = await p;
    expect(r.outputFile).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it('over cap — spill created and complete', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p: Promise<SingleResult> = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout('a'.repeat(1100 * 1024));
    fake.writeStdout('b'.repeat(50 * 1024));
    fake.writeStdout('c'.repeat(1024));
    fake.finish(0);
    const r = await p;
    expect(typeof r.outputFile).toBe('string');
    expect(r.outputFile!.endsWith('scout.log')).toBe(true);
    expect(r.outputFile).toContain('pisubagent-spill-');
    expect(r.outputFile!.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(r.outputFile!)).toBe(true);
    expect(fs.statSync(r.outputFile!).size).toBe((1100 + 50 + 1) * 1024);
    const raw = fs.readFileSync(r.outputFile!);
    expect(raw.subarray(0, 1024).toString('utf8')).toBe('a'.repeat(1024));
    expect(raw.subarray(raw.length - 1024).toString('utf8')).toBe('c'.repeat(1024));
    expect(r.stderr).toContain('[truncated: stdout exceeded 1MB — full output: ');
    spillDirs.push(path.dirname(r.outputFile!));
  });

  it('stderr marker emitted once even with more overflow', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p: Promise<SingleResult> = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout('a'.repeat(1100 * 1024));
    fake.writeStdout('b'.repeat(50 * 1024));
    fake.writeStdout('c'.repeat(1024));
    fake.writeStdout('d'.repeat(200 * 1024));
    fake.finish(0);
    const r = await p;
    const marker = '[truncated: stdout exceeded 1MB';
    expect(r.stderr.split(marker).length - 1).toBe(1);
    expect(fs.statSync(r.outputFile!).size).toBe((1100 + 50 + 1 + 200) * 1024);
    spillDirs.push(path.dirname(r.outputFile!));
  });

  it('early JSONL still processed before spill', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p: Promise<SingleResult> = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout(
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [] } }) + '\n',
    );
    fake.writeStdout('a'.repeat(1100 * 1024));
    fake.writeStdout('b'.repeat(50 * 1024));
    fake.finish(0);
    const r = await p;
    expect(r.messages.length).toBeGreaterThanOrEqual(1);
    spillDirs.push(path.dirname(r.outputFile!));
  });

  it('file persists after run', async () => {
    const fake = makeFakeProc();
    const runner = new SubprocessRunner({ spawnFn: (() => fake.proc) as never });
    const p: Promise<SingleResult> = runner.run(baseInput);
    await waitForCloseListener(fake);
    fake.writeStdout('a'.repeat(1100 * 1024));
    fake.writeStdout('b'.repeat(50 * 1024));
    fake.finish(0);
    const r = await p;
    expect(fs.existsSync(r.outputFile!)).toBe(true);
    spillDirs.push(path.dirname(r.outputFile!));
  });
});
