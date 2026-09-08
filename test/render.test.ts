import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { renderCall, renderResult } from "../src/render.js";
import type { SingleResult, SubagentDetails } from "../src/types.js";

const theme = {
  bold: (s: string) => `**${s}**`,
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
};

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "scout",
    agentSource: "user",
    task: "x",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: "sonnet",
    ...overrides,
  };
}

function details(mode: SubagentDetails["mode"], results: SingleResult[]): SubagentDetails {
  return { mode, agentScope: "user", projectAgentsDir: null, results };
}

describe("renderCall", () => {
  it("renders single mode with agent name + task preview", () => {
    const t = renderCall({ agent: "scout", task: "find auth code" }, theme as never);
    expect(t).toContain("**subagent **");
    expect(t).toContain("scout");
    expect(t).toContain("find auth code");
    expect(t).toContain("[user]");
  });

  it("renders parallel mode with task count", () => {
    const t = renderCall(
      { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] },
      theme as never,
    );
    expect(t).toContain("parallel");
    expect(t).toContain("2 tasks");
  });

  it("renders chain mode with step count and strips {previous} from preview", () => {
    const t = renderCall(
      { chain: [{ agent: "planner", task: "plan using {previous}" }] },
      theme as never,
    );
    expect(t).toContain("chain");
    expect(t).toContain("1 steps");
    expect(t).not.toContain("{previous}");
  });

  it("caps previews at 40 chars for chain steps", () => {
    const long = "z".repeat(100);
    const t = renderCall({ chain: [{ agent: "a", task: long }] }, theme as never);
    expect(t).toContain("...");
    expect(t).toContain("z".repeat(40));
  });
});

describe("renderResult", () => {
  it("single success: shows check, agent name, source, usage", () => {
    const r = renderResult(
      {
        content: [{ type: "text", text: "found it" }],
        details: details("single", [makeResult({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 } })]),
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toContain("[success]✓[/success]");
    expect(r).toContain("**scout**");
    expect(r).toContain("(user)");
    expect(r).toContain("2 turns");
  });

  it("single failure: shows cross, stopReason, and error message", () => {
    const r = renderResult(
      {
        content: [{ type: "text", text: "boom" }],
        details: details("single", [makeResult({ exitCode: 1, stopReason: "error", errorMessage: "model 404" })]),
        isError: true,
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toContain("[error]✗[/error]");
    expect(r).toContain("[error]");
    expect(r).toContain("model 404");
  });

  it("collapsed view caps display items and notes skipped count", () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `line ${i}` }],
    })) as unknown as Message[];
    const r = renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: details("single", [makeResult({ messages })]),
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toMatch(/\.\.\. 5 earlier items/);
  });

  it("expanded view includes the final assistant text", () => {
    const messages = [
      { role: "assistant" as const, content: [{ type: "text" as const, text: "FINAL ANSWER TEXT" }] },
    ] as unknown as Message[];
    const r = renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: details("single", [makeResult({ messages })]),
      },
      { expanded: true },
      theme as never,
    );
    expect(r).toContain("FINAL ANSWER TEXT");
  });

  it("parallel/chain: shows success fraction and per-agent icons", () => {
    const r = renderResult(
      {
        content: [{ type: "text", text: "batch" }],
        details: details("parallel", [makeResult({ agent: "a" }), makeResult({ agent: "b", exitCode: 1, stopReason: "error" })]),
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toContain("1/2");
    expect(r).toContain("a");
    expect(r).toContain("b");
  });

  it("no results: returns content text", () => {
    const r = renderResult(
      {
        content: [{ type: "text", text: "nothing ran" }],
        details: details("single", []),
      },
      { expanded: false },
      theme as never,
    );
    expect(r).toBe("nothing ran");
  });
});
