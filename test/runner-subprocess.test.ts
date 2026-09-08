import { describe, it, expect, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import {
  resolvePiInvocation,
  writePromptFile,
  killOnAbort,
  parseJsonlEvents,
  SubprocessRunner,
} from "../src/runner/subprocess.js";

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
