import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import {
  resolvePiInvocation,
  writePromptFile,
  killOnAbort,
  parseJsonlEvents,
  SubprocessRunner,
} from "../src/runner/subprocess.js";

// Hoisted mocks for fs.rmSync, fs.promises.writeFile, and
// fs.promises.mkdtemp. We mock BOTH `node:fs` (so subprocess.ts's
// `fs.promises.<x>` calls are intercepted) AND `node:fs/promises` (so the
// test file's own `fs` import sees the same instances). The mocks are
// registered through vi.hoisted so they're available to the hoisted
// vi.mock factories.
//
// Default behavior delegates to the real implementation so unrelated
// tests (e.g. writePromptFile cleanup) keep working without per-test
// configuration. Tests that want to force a specific behavior configure
// the mock via .mockResolvedValue / .mockRejectedValue.
//
// Note: vi.mock("node:fs/promises", ...) alone does NOT intercept calls
// made through `import * as fs from "node:fs"; fs.promises.<x>(...)`,
// because Node.js exposes `fs.promises` as a sub-namespace on `node:fs`
// and Vitest's mock for `node:fs/promises` doesn't propagate there.
const fsMocks = vi.hoisted(() => ({
  rmSync: vi.fn(),
  writeFile: vi.fn(),
  mkdtemp: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.rmSync.mockImplementation(
    actual.rmSync as unknown as (...args: unknown[]) => void,
  );
  fsMocks.writeFile.mockImplementation(
    actual.promises.writeFile as unknown as (...args: unknown[]) => Promise<void>,
  );
  fsMocks.mkdtemp.mockImplementation(
    actual.promises.mkdtemp as unknown as (...args: unknown[]) => Promise<string>,
  );
  return {
    ...actual,
    rmSync: fsMocks.rmSync,
    promises: { ...actual.promises, writeFile: fsMocks.writeFile, mkdtemp: fsMocks.mkdtemp },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: fsMocks.writeFile,
    mkdtemp: fsMocks.mkdtemp,
  };
});

describe("resolvePiInvocation", () => {
  it("returns argv-based invocation when current script exists on disk", () => {
    const result = resolvePiInvocation(["--help"]);
    // Under vitest, process.argv[1] is the vitest binary which exists on disk,
    // so we take the argv branch: [currentScript, ...args].
    expect(result.command).toBe(process.execPath);
    expect(result.args[result.args.length - 1]).toBe("--help");
  });

  it("falls back to bare 'pi' when script is a bun virtual path", () => {
    const original = process.argv[1];
    process.argv[1] = "/$bunfs/root/pi";
    const result = resolvePiInvocation(["--mode", "json"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "json"]);
    process.argv[1] = original;
  });

  it("falls back to bare 'pi' when script path does not exist", () => {
    const original = process.argv[1];
    process.argv[1] = "/nonexistent/script.ts";
    const result = resolvePiInvocation(["--mode", "json"]);
    expect(result.command).toBe("pi");
    process.argv[1] = original;
  });
});

describe("writePromptFile", () => {
  it("writes prompt content to a temp file and returns paths", async () => {
    const result = await writePromptFile("agent-name", "system prompt body");
    expect(result.filePath).toMatch(/prompt-agent-name\.md$/);
    const content = await fs.readFile(result.filePath, "utf-8");
    expect(content).toBe("system prompt body");
    await fs.rm(result.dir, { recursive: true, force: true });
  });

  it("sanitizes unsafe agent names", async () => {
    const result = await writePromptFile("bad name/space!", "x");
    expect(result.filePath).toMatch(/prompt-bad_name_space_\.md$/);
    await fs.rm(result.dir, { recursive: true, force: true });
  });
});

describe("killOnAbort", () => {
  function fakeProc(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
    return Object.assign({}, { killed: false, kill: vi.fn() }) as never;
  }

  it("sends SIGTERM immediately on abort, escalates to SIGKILL after 5s", () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const controller = new AbortController();
    killOnAbort(proc, controller.signal);
    controller.abort();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(5100);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("kills immediately when signal is already aborted", () => {
    const proc = fakeProc();
    const controller = new AbortController();
    controller.abort();
    killOnAbort(proc, controller.signal);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not kill when signal never aborts", () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const controller = new AbortController();
    killOnAbort(proc, controller.signal);
    vi.advanceTimersByTime(10_000);
    expect(proc.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("parseJsonlEvents", () => {
  it("yields parsed events from newline-delimited input", () => {
    const events = [
      { type: "message_end", message: { role: "assistant", content: [] } },
      { type: "tool_result_end", message: { role: "toolResult", content: [] } },
    ];
    const stream = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const collected = [...parseJsonlEvents(stream)];
    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual(events[0]);
  });

  it("skips malformed lines and blank lines", () => {
    const stream = "not-json\n\n" + JSON.stringify({ type: "ok" }) + "\n";
    const collected = [...parseJsonlEvents(stream)];
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({ type: "ok" });
  });
});

describe("SubprocessRunner.buildArgs (CLI flag composition)", () => {
  const noop = () => ({} as never);
  const baseAgent = {
    name: "scout",
    description: "",
    systemPrompt: "",
    source: "bundled" as const,
    filePath: "",
  };

  it("always starts with --mode json -p --no-session; Task line comes via buildSuffix", () => {
    const runner = new SubprocessRunner({ spawnFn: noop });
    const args = runner.buildArgs(
      { agent: baseAgent, task: "find auth", cwd: "/tmp" },
      {},
    );
    expect(args.slice(0, 4)).toEqual(["--mode", "json", "-p", "--no-session"]);
    expect(args[args.length - 1]).toBe("--no-session");
    // Full ordering when a system prompt is present:
    // prefix + [--append-system-prompt <tmp>] + [Task: ...]
    const suffix = runner.buildSuffix("You are X.", "find auth");
    expect(suffix[suffix.length - 1]).toBe("Task: find auth");
  });

  it("appends --model when agent.model is set", () => {
    const runner = new SubprocessRunner({ spawnFn: noop });
    const args = runner.buildArgs(
      { agent: { ...baseAgent, model: "claude-sonnet-4-5" }, task: "x", cwd: "/tmp" },
      {},
    );
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("claude-sonnet-4-5");
  });

  it("falls back to parentModel when agent.model unset", () => {
    const runner = new SubprocessRunner({ spawnFn: noop });
    const args = runner.buildArgs(
      { agent: baseAgent, task: "x", cwd: "/tmp" },
      { parentModel: "anthropic/claude-haiku-4-5" },
    );
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("anthropic/claude-haiku-4-5");
  });

  it("appends --thinking only when agent.model unset AND parentThinkingLevel provided", () => {
    const runner = new SubprocessRunner({ spawnFn: noop });
    const withInherit = runner.buildArgs(
      { agent: baseAgent, task: "x", cwd: "/tmp" },
      { parentThinkingLevel: "low" },
    );
    const idx = withInherit.indexOf("--thinking");
    expect(idx).toBeGreaterThan(-1);
    expect(withInherit[idx + 1]).toBe("low");

    // agent.model set → thinking NOT inherited
    const withModel = runner.buildArgs(
      { agent: { ...baseAgent, model: "claude-sonnet-4-5" }, task: "x", cwd: "/tmp" },
      { parentThinkingLevel: "low" },
    );
    expect(withModel).not.toContain("--thinking");
  });

  it("appends --tools comma-joined only when agent.tools present", () => {
    const runner = new SubprocessRunner({ spawnFn: noop });
    const withTools = runner.buildArgs(
      { agent: { ...baseAgent, tools: ["read", "bash"] }, task: "x", cwd: "/tmp" },
      {},
    );
    const idx = withTools.indexOf("--tools");
    expect(withTools[idx + 1]).toBe("read,bash");

    const withoutTools = runner.buildArgs(
      { agent: baseAgent, task: "x", cwd: "/tmp" },
      {},
    );
    expect(withoutTools).not.toContain("--tools");
  });

  it("buildSuffix emits --append-system-prompt sentinel + Task line only when prompt non-empty", () => {
    const runner = new SubprocessRunner({ spawnFn: noop });
    expect(runner.buildSuffix("You are X.", "do it")).toEqual([
      "--append-system-prompt",
      "<tempFile>",
      "Task: do it",
    ]);
    expect(runner.buildSuffix("", "do it")).toEqual(["Task: do it"]);
    expect(runner.buildSuffix("   ", "do it")).toEqual(["Task: do it"]);
  });
});

describe("SubprocessRunner.run hardening", () => {
  const baseAgent = {
    name: "scout",
    description: "",
    systemPrompt: "",
    source: "bundled" as const,
    filePath: "",
  };
  const baseInput = { agent: baseAgent, task: "x", cwd: "/tmp" };
  const validLine = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [] },
  });

  /**
   * Minimal ChildProcess fake with proper Readable stdout/stderr and
   * EventEmitter semantics for the events run() subscribes to
   * (data, close, error). `kill` is a vi.fn; with `killFiresClose: true`
   * it also emits `close` asynchronously so the Promise resolves.
   */
  function makeFakeProc(opts: { killFiresClose?: boolean } = {}): ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  } {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = new EventEmitter() as unknown as ChildProcess & {
      kill: ReturnType<typeof vi.fn>;
    };
    (proc as unknown as { stdout: Readable }).stdout = stdout;
    (proc as unknown as { stderr: Readable }).stderr = stderr;
    (proc as unknown as { killed: boolean }).killed = false;
    (proc as unknown as { exitCode: number | null }).exitCode = null;
    proc.kill = vi.fn(((sig?: NodeJS.Signals) => {
      (proc as unknown as { killed: boolean }).killed = true;
      if (opts.killFiresClose) {
        setImmediate(() => proc.emit("close", null));
      }
      return true;
    }) as unknown as typeof proc.kill);
    return proc;
  }

  /** Push all chunks synchronously then end the stream; emit close after. */
  function emit(
    proc: ChildProcess & { kill: ReturnType<typeof vi.fn> },
    stdoutChunks: (string | Buffer)[],
    closeCode: number | null = 0,
  ): Promise<void> {
    return new Promise((resolve) => {
      const stdout = (proc as unknown as { stdout: Readable }).stdout;
      const stderr = (proc as unknown as { stderr: Readable }).stderr;
      for (const c of stdoutChunks) stdout.push(c);
      stdout.push(null);
      stderr.push(null);
      proc.once("close", () => resolve());
      // Poll for the runner's close listener before emitting close. The
      // runner adds a single 'on' listener inside the spawn Promise body;
      // combined with this helper's 'once' listener, the count reaches 2
      // once the runner is ready. Avoids a race where the runner hasn't
      // reached its await new Promise(...) yet because an earlier await
      // (e.g. fs.realpath in writePromptFile) is still pending.
      let attempts = 0;
      const waitForListener = () => {
        if (++attempts > 200) return; // give up after ~200 ticks
        if (proc.listenerCount("close") >= 2) {
          proc.emit("close", closeCode);
        } else {
          setImmediate(waitForListener);
        }
      };
      setImmediate(waitForListener);
    });
  }

  it("caps stdout at 1MB and appends a one-time truncation marker to stderr", async () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const runner = new SubprocessRunner({ spawnFn: spawn as never });

    const promise = runner.run(baseInput);
    // 2 MB written incrementally: 2 valid lines first (will survive),
    // then 2 MB no-newline padding (overflows the buffer), then 2 more
    // valid lines (must be dropped once truncation kicks in).
    const padding = "x".repeat(2 * 1024 * 1024);
    await emit(proc, [validLine + "\n" + validLine + "\n", padding, validLine + "\n" + validLine + "\n"]);
    const result = await promise;

    expect(result.stderr).toContain("[truncated: stdout exceeded 1MB]");
    // Only the 2 valid lines before truncation should have made it in.
    expect(result.messages).toHaveLength(2);
  });

  it("kills the subprocess and reports aborted when runTimeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProc({ killFiresClose: true });
      const spawn = vi.fn(() => proc);
      const runner = new SubprocessRunner({
        spawnFn: spawn as never,
        runTimeoutMs: 100,
      });

      const promise = runner.run(baseInput);
      // Advance past the timeout (and a tick for the setImmediate-fired close).
      vi.advanceTimersByTime(150);
      // Flush microtasks so the emitted close resolves the inner Promise.
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.stopReason).toBe("aborted");
      expect(result.errorMessage).toMatch(/run timeout/);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not propagate onUpdate callback exceptions out of run()", async () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const runner = new SubprocessRunner({ spawnFn: spawn as never });

    const onUpdate = vi.fn(() => {
      throw new Error("callback boom");
    });

    const promise = runner.run(baseInput, undefined, onUpdate);
    await emit(proc, [validLine + "\n"]);
    const result = await promise;

    expect(onUpdate).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("onUpdate callback threw");
  });

  it("counts malformed JSONL lines and reports a single stderr summary at end", async () => {
    const proc = makeFakeProc();
    const spawn = vi.fn(() => proc);
    const runner = new SubprocessRunner({ spawnFn: spawn as never });

    const lines = [
      validLine,
      "{not json 1",
      validLine,
      "{not json 2",
      "{not json 3",
      validLine,
      "{not json 4",
    ].join("\n") + "\n";

    const promise = runner.run(baseInput);
    await emit(proc, [lines]);
    const result = await promise;

    expect(result.messages).toHaveLength(3);
    expect(result.stderr).toContain("[subprocess: 4 malformed JSONL lines dropped]");
  });

  it("uses fs.rmSync with recursive: true for tmpdir cleanup when writePromptFile fails", async () => {
    // Configure the hoisted mocks for this run.
    fsMocks.writeFile.mockRejectedValue(new Error("disk full"));
    fsMocks.mkdtemp.mockResolvedValue("/tmp/pi-subagent-fake");
    fsMocks.rmSync.mockClear();

    try {
      const proc = makeFakeProc();
      const spawn = vi.fn(() => proc);
      const runner = new SubprocessRunner({ spawnFn: spawn as never });

      const promise = runner.run({
        ...baseInput,
        agent: { ...baseAgent, systemPrompt: "needs disk" },
      });
      await emit(proc, []);
      const result = await promise;

      // run() must not propagate the writeFile failure.
      expect(result).toBeDefined();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("failed to write system prompt");

      // rmSync must have been called with recursive: true (either inside
      // writePromptFile's self-cleanup or inside run()'s finally block).
      expect(fsMocks.rmSync.mock.calls.length).toBeGreaterThan(0);
      const recursiveCalls = fsMocks.rmSync.mock.calls.filter(
        (call) =>
          typeof call[1] === "object" &&
          call[1] !== null &&
          (call[1] as { recursive?: boolean }).recursive === true,
      );
      expect(recursiveCalls.length).toBeGreaterThan(0);
    } finally {
      fsMocks.writeFile.mockReset();
      fsMocks.mkdtemp.mockReset();
      fsMocks.rmSync.mockReset();
    }
  });
});
