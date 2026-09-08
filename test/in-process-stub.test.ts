import { describe, it, expect } from "vitest";
import { InProcessRunner } from "../src/runner/in-process.js";

describe("InProcessRunner (v2 stub)", () => {
  it("has id 'in-process'", () => {
    expect(new InProcessRunner().id).toBe("in-process");
  });

  it("run() rejects with a doc-link to the spec's v2 section", async () => {
    const runner = new InProcessRunner();
    await expect(
      runner.run({
        agent: { name: "x", description: "", systemPrompt: "", source: "bundled", filePath: "" },
        task: "",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/v2; not implemented in PiSubagent v1/);
  });
});
