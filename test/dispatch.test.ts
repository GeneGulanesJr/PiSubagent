import { describe, it, expect, vi } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import {
  detectMode,
  buildInvalidParamsError,
  execute,
  MAX_CONCURRENCY,
  PER_TASK_OUTPUT_CAP,
  type DispatchContext,
} from "../src/dispatch.js";
import type { AgentRunner } from "../src/runner/runner.js";
import type { AgentConfig, SingleResult } from "../src/types.js";

/** Build a deferred promise the test can resolve manually. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Minimal successful SingleResult, sufficient for dispatch-level tests. */
function makeFakeResult(agentName: string): SingleResult {
  return {
    agent: agentName,
    agentSource: "user",
    task: "t",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: "fake",
  };
}

/** SingleResult whose final assistant text is `text`. Only the shape read by
 *  output.ts (role/content) matters to dispatch; other AssistantMessage fields
 *  are intentionally omitted and the message is cast to Message[]. */
function makeResultWithText(agentName: string, text: string): SingleResult {
  const messages = [
    { role: "assistant", content: [{ type: "text", text }] },
  ] as unknown as Message[];
  return {
    ...makeFakeResult(agentName),
    messages,
  };
}

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

// Regression: issue #1 Bug 1 — MAX_CONCURRENCY = 4 is a per-batch cap that
// must be enforced by runParallel. Spec: docs/superpowers/specs/2026-09-08
// -pisubagent-design.md § Limits + § dispatch.test.ts (parallel concurrency
// limit). Prior to the fix, runParallel fired every task via bare Promise.all,
// which left the cap unenforced.
describe("runParallel concurrency cap (issue #1, Bug 1)", () => {
  it(`never has more than MAX_CONCURRENCY (=${MAX_CONCURRENCY}) tasks in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    let startedCount = 0;
    const allStarted = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        startedCount++;
        // Signal the test once the first batch has fully arrived at the cap.
        // Batches are gated on Promise.all of the prior batch, so no later
        // task can start while we're holding here.
        if (startedCount === MAX_CONCURRENCY) allStarted.resolve(undefined);
        await release.promise;
        inFlight--;
        return makeFakeResult(input.agent.name);
      },
    };

    // 6 tasks > MAX_CONCURRENCY → forces at least two batches.
    const tasks = Array.from({ length: 6 }, (_, i) => ({ agent: "a", task: `t${i}` }));
    const agents: AgentConfig[] = [
      { name: "a", description: "", systemPrompt: "", source: "bundled", filePath: "" },
    ];
    const ctx: DispatchContext = {
      cwd: "/tmp",
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { confirm: async () => true },
    };

    const executePromise = execute({ tasks }, ctx, agents, runner);

    // Wait until the first batch has fully reached the cap.
    await allStarted.promise;
    expect(peak).toBe(MAX_CONCURRENCY);
    expect(inFlight).toBe(MAX_CONCURRENCY);
    // No tasks past the cap have started yet.
    expect(startedCount).toBe(MAX_CONCURRENCY);

    // Release batch 1; batch 2 will then run (with 2 tasks). Peak should
    // still never exceed MAX_CONCURRENCY.
    release.resolve(undefined);
    const out = await executePromise;

    expect(peak).toBe(MAX_CONCURRENCY); // cap held across both batches
    expect(out.isError).toBe(false);
    expect(out.details.results).toHaveLength(6);
    expect(out.details.mode).toBe("parallel");
  });
});

// Regression: issue #1 Bug 2 — execute() denial path must report the actual
// mode in details.mode, not a placeholder. Before the fix, parallel and
// chain calls denied at the project-agent confirmation gate would report
// mode: "single", which lies to downstream consumers (render, logging, etc.).
describe("execute() denial path: details.mode (issue #1, Bug 2)", () => {
  const projectAgent: AgentConfig = {
    name: "repo-reviewer",
    description: "x",
    systemPrompt: "",
    source: "project",
    filePath: "/fake/repo-reviewer.md",
  };
  const deniedCtx = () => ({
    cwd: "/tmp",
    hasUI: false, // no UI → confirmProjectAgentsIfNeeded blocks
    isProjectTrusted: () => false, // untrusted
    ui: { confirm: vi.fn() },
  });

  it("parallel mode denied → details.mode === 'parallel'", async () => {
    const out = await execute(
      { agentScope: "project", tasks: [{ agent: "repo-reviewer", task: "x" }] },
      deniedCtx() as never,
      [projectAgent],
    );
    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe("parallel");
  });

  it("chain mode denied → details.mode === 'chain'", async () => {
    const out = await execute(
      { agentScope: "project", chain: [{ agent: "repo-reviewer", task: "x" }] },
      deniedCtx() as never,
      [projectAgent],
    );
    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe("chain");
  });

  it("single mode denied → details.mode === 'single' (no regression)", async () => {
    const out = await execute(
      { agentScope: "project", agent: "repo-reviewer", task: "x" },
      deniedCtx() as never,
      [projectAgent],
    );
    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe("single");
  });
});

// Regression: issue #2 Bug 1 — runParallel must cap each per-agent summary
// body at PER_TASK_OUTPUT_CAP bytes before joining into content[0].text.
// Spec: docs/superpowers/specs/2026-09-08-pisubagent-design.md § Limits.
// Prior to the fix, summaries[i].body was the raw getResultOutput(r); a single
// chatty agent could flood the parent's context with multi-MB content text.
// The full output is still preserved in details.results[i].messages — only
// the joined `content[0].text` payload is capped.
describe("runParallel truncates each per-agent output to PER_TASK_OUTPUT_CAP", () => {
  it("caps every per-agent summary body and marks the join", async () => {
    // 80KB of text > 50KB cap so truncation MUST happen.
    const big = "x".repeat(80 * 1024);
    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => makeResultWithText(input.agent.name, big),
    };
    const tasks = [
      { agent: "a", task: "t0" },
      { agent: "a", task: "t1" },
    ];
    const agents: AgentConfig[] = [
      { name: "a", description: "", systemPrompt: "", source: "bundled", filePath: "" },
    ];
    const ctx: DispatchContext = {
      cwd: "/tmp",
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { confirm: async () => true },
    };

    const out = await execute({ tasks }, ctx, agents, runner);
    expect(out.isError).toBe(false);
    expect(out.details.mode).toBe("parallel");
    expect(out.details.results).toHaveLength(tasks.length);

    const text = out.content[0].type === "text" ? out.content[0].text : "";
    const marker = "[Output truncated:";
    // Exactly one truncation marker per result.
    expect(text.split(marker).length - 1).toBe(tasks.length);
    expect(text).toContain(marker);
    // Joined payload must be much smaller than the un-capped raw output.
    // Each summary body is capped at PER_TASK_OUTPUT_CAP plus the marker +
    // small per-agent heading; two summaries must comfortably fit.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(
      PER_TASK_OUTPUT_CAP * tasks.length + 512,
    );
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(PER_TASK_OUTPUT_CAP);

    // details.results must still hold the full untruncated messages.
    for (const r of out.details.results) {
      const msg = r.messages[0] as { content: Array<{ type: string; text?: string }> };
      expect(msg.content[0].text?.length).toBe(80 * 1024);
    }
  });

  it("leaves small outputs untouched (no marker when below cap)", async () => {
    // 1KB << 50KB cap → no truncation.
    const small = "y".repeat(1024);
    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => makeResultWithText(input.agent.name, small),
    };
    const tasks = [{ agent: "a", task: "t0" }];
    const agents: AgentConfig[] = [
      { name: "a", description: "", systemPrompt: "", source: "bundled", filePath: "" },
    ];
    const ctx: DispatchContext = {
      cwd: "/tmp",
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { confirm: async () => true },
    };
    const out = await execute({ tasks }, ctx, agents, runner);
    const text = out.content[0].type === "text" ? out.content[0].text : "";
    expect(text).not.toContain("[Output truncated:");
    expect(text).toContain("y".repeat(64)); // a chunk of the small payload
  });
});

// Regression: issue #2 Bug 6 — runChain must cap the previous step's output
// before substituting it into the next step's prompt. Without the cap, a
// 1MB prior output becomes a 1MB prompt for the next step. Spec: docs/superpowers
// /specs/2026-09-08-pisubagent-design.md § Limits. truncateParallelOutput is
// the canonical reducer (shared with the parallel path), so the marker is the
// same `[Output truncated: ... bytes omitted]` the parent will see.
describe("runChain caps {previous} to PER_TASK_OUTPUT_CAP", () => {
  it("truncates previous step output before substituting into next step", async () => {
    // 80KB final text > 50KB cap so truncation MUST happen.
    const big = "y".repeat(80 * 1024);
    const calls: Array<{ agent: string; resolvedTask?: string }> = [];
    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => {
        calls.push({ agent: input.agent.name, resolvedTask: input.resolvedTask });
        // Step 1 emits the big text. Step 2 emits an empty success.
        return calls.length === 1
          ? makeResultWithText(input.agent.name, big)
          : makeFakeResult(input.agent.name);
      },
    };
    const agents: AgentConfig[] = [
      { name: "a", description: "", systemPrompt: "", source: "bundled", filePath: "" },
      { name: "b", description: "", systemPrompt: "", source: "bundled", filePath: "" },
    ];
    const ctx: DispatchContext = {
      cwd: "/tmp",
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { confirm: async () => true },
    };
    const chain = [
      { agent: "a", task: "produce output" },
      { agent: "b", task: "consume {previous}" },
    ];

    const out = await execute({ chain }, ctx, agents, runner);
    expect(out.isError).toBe(false);
    expect(calls).toHaveLength(2);

    // Step 1 has no {previous} placeholder → resolvedTask is the raw task.
    expect(calls[0].resolvedTask).toBe("produce output");

    // Step 2's prompt is the truncated previous output. The marker MUST be
    // present and the full 80KB MUST NOT be embedded in the prompt.
    const step2Resolved = calls[1].resolvedTask;
    expect(step2Resolved).toBeDefined();
    expect(step2Resolved).toContain("[Output truncated:");
    expect(step2Resolved!.length).toBeLessThan(80 * 1024);
    // The preserved prefix is still there (truncateParallelOutput keeps the
    // first PER_TASK_OUTPUT_CAP bytes verbatim).
    expect(step2Resolved).toContain("y");
  });
});
