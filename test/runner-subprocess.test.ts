import { describe, it, expect, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import {
  resolvePiInvocation,
  writePromptFile,
  killOnAbort,
  parseJsonlEvents,
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
