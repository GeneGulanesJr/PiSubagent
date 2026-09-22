import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as subagentMod from "../src/index.js";

const registerTool = vi.fn();
const pi = { registerTool } as unknown as ExtensionAPI;

beforeAll(() => {
  subagentMod.default(pi);
});

describe("subagent tool registration", () => {
  it("registers exactly one tool named 'subagent' with label 'Subagent'", () => {
    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0][0];
    expect(tool.name).toBe("subagent");
    expect(tool.label).toBe("Subagent");
  });

  it("has a non-empty description describing all three modes", () => {
    const tool = registerTool.mock.calls[0][0];
    expect(typeof tool.description).toBe("string");
    expect(tool.description).toContain("single");
    expect(tool.description).toContain("parallel");
    expect(tool.description).toContain("chain");
    expect(tool.description).toContain("agentScope");
  });

  it("exposes a parameters schema object", () => {
    const tool = registerTool.mock.calls[0][0];
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.parameters).toBe("object");
  });

  it("exposes renderCall and renderResult hooks", () => {
    const tool = registerTool.mock.calls[0][0];
    expect(typeof tool.renderCall).toBe("function");
    expect(typeof tool.renderResult).toBe("function");
  });

  it("renderCall delegates with theme pass-through (returns pi-tui Text)", () => {
    const tool = registerTool.mock.calls[0][0];
    const theme = { bold: (s: string) => `b(${s})`, fg: (c: string, t: string) => `f(${c},${t})` };
    const out = tool.renderCall({ agent: "scout", task: "x" }, theme) as { text: string };
    expect(out.text).toContain("b(subagent )");
    expect(out.text).toContain("f(accent,scout)");
  });

  it("renderResult delegates collapsed output for empty results (returns pi-tui Text)", () => {
    const tool = registerTool.mock.calls[0][0];
    const theme = { bold: (s: string) => s, fg: (_c: string, t: string) => t };
    const out = tool.renderResult(
      { content: [{ type: "text", text: "plain" }], details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } },
      { expanded: false },
      theme,
    ) as { text: string };
    expect(out.text).toBe("plain");
  });
});
