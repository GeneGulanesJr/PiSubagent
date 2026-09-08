import { describe, it, expect, vi } from "vitest";
import { detectMode, buildInvalidParamsError } from "../src/dispatch.js";
import type { AgentConfig } from "../src/types.js";

describe("detectMode", () => {
  it("returns 'single' when agent + task present", () => {
    expect(detectMode({ agent: "x", task: "y" })).toBe("single");
  });
  it("returns 'parallel' when tasks[] has entries", () => {
    expect(detectMode({ tasks: [{ agent: "x", task: "y" }] })).toBe("parallel");
  });
  it("returns 'chain' when chain[] has entries", () => {
    expect(detectMode({ chain: [{ agent: "x", task: "y" }] })).toBe("chain");
  });
  it("returns 'invalid' when nothing provided", () => {
    expect(detectMode({})).toBe("invalid");
  });
  it("returns 'invalid' when both single AND parallel present", () => {
    expect(detectMode({ agent: "x", task: "y", tasks: [{ agent: "a", task: "b" }] })).toBe("invalid");
  });
  it("returns 'invalid' when single-mode agent without task", () => {
    expect(detectMode({ agent: "x" })).toBe("invalid");
  });
  it("treats empty tasks/chain arrays as absent", () => {
    expect(detectMode({ tasks: [], chain: [] })).toBe("invalid");
    expect(detectMode({ agent: "x", task: "y", tasks: [] })).toBe("single");
  });
});

describe("buildInvalidParamsError", () => {
  const agents: AgentConfig[] = [
    { name: "scout", description: "recon", systemPrompt: "", source: "bundled", filePath: "" },
    { name: "worker", description: "impl", systemPrompt: "", source: "bundled", filePath: "" },
  ];

  it("lists available agents and flags isError", () => {
    const out = buildInvalidParamsError(agents);
    expect(out.isError).toBe(true);
    const text = out.content[0].type === "text" ? out.content[0].text : "";
    expect(text).toContain("scout");
    expect(text).toContain("worker");
    expect(text).toContain("exactly one mode");
  });

  it("says 'none' when no agents discovered", () => {
    const out = buildInvalidParamsError([]);
    const text = out.content[0].type === "text" ? out.content[0].text : "";
    expect(text).toContain("none");
  });
});

// Sanity: the module must also export execute + limits (filled in Task 12).
describe("dispatch module surface", () => {
  it("exposes execute and limit constants", async () => {
    const mod = await import("../src/dispatch.js");
    expect(typeof mod.execute).toBe("function");
    expect(mod.MAX_PARALLEL_TASKS).toBe(8);
    expect(mod.MAX_CONCURRENCY).toBe(4);
    expect(mod.PER_TASK_OUTPUT_CAP).toBe(50 * 1024);
  });
});
