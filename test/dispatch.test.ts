import { describe, it, expect, vi } from "vitest";
import {
  detectMode,
  buildInvalidParamsError,
  execute,
  MAX_CONCURRENCY,
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
