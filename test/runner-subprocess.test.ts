import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { resolvePiInvocation, writePromptFile } from "../src/runner/subprocess.js";

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
