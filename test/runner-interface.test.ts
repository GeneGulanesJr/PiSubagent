import { describe, it, expect } from "vitest";
import type { AgentRunner, AgentRunInput } from "../src/runner/runner.js";
import type { SingleResult } from "../src/types.js";

describe("AgentRunner contract", () => {
  it("is implementable by a class with id literal", async () => {
    class TestRunner implements AgentRunner {
      readonly id = "subprocess" as const;
      async run(_input: AgentRunInput): Promise<SingleResult> {
        return {
          agent: "x",
          agentSource: "unknown",
          task: "",
          exitCode: 0,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        };
      }
    }
    const runner = new TestRunner();
    expect(runner.id).toBe("subprocess");
    const result = await runner.run({
      agent: { name: "x", description: "", systemPrompt: "", source: "bundled", filePath: "" },
      task: "",
      cwd: "/tmp",
    });
    expect(result.agent).toBe("x");
  });
});
