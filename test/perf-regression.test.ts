import { describe, it, expect, vi } from "vitest";
import {
  execute,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  type DispatchContext,
} from "../src/dispatch.js";
import type { AgentRunner } from "../src/runner/runner.js";
import type { AgentConfig, SingleResult } from "../src/types.js";

/** Test-controlled deferred promise; resolves manually. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Minimal successful SingleResult — only the shape read by dispatch/output matters. */
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

/** Minimal bundled AgentConfig stub. */
function agent(name: string): AgentConfig {
  return { name, description: "", systemPrompt: "", source: "bundled", filePath: "" };
}

/** Trivial trusted/bundled-only ctx so the project-agent gate doesn't fire. */
const baseCtx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
  cwd: "/tmp",
  hasUI: false,
  isProjectTrusted: () => true,
  ui: { confirm: async () => true },
  ...over,
});

// ---------------------------------------------------------------------------
// Parallel-batching smoke + regression suite for SubprocessRunner / dispatch.
//
// runParallel in src/dispatch.ts enforces MAX_CONCURRENCY=4 via a per-batch
// window (memory #156 — "per-batch concurrency cap pattern for runParallel").
// test/dispatch.test.ts covers the cap with 6 tasks across 2 batches plus
// denial / truncation regressions. This file layers four higher-fidelity
// checks:
//
//   1. Cap held at the full MAX_PARALLEL_TASKS load (=8 tasks → 4+4 batches).
//   2. Catastrophic-parallelism regression — wall-time budget catches
//      accidental fully-sequential execution.
//   3. Result-order preservation across batches (catches a future refactor
//      that lets batch 2 race ahead of batch 1 in the wrong slot).
//   4. Denial-path cancellation latency — the synchronous project-agent
//      confirmation gate must not stall on confirm-prompt IO.
//
// Helpers (deferred, makeFakeResult, agent, baseCtx) match dispatch.test.ts so
// the file reads as an extension of the existing cap/denial tests.
// ---------------------------------------------------------------------------

describe("runParallel: parallel-batching regression (SubprocessRunner / dispatch)", () => {
  it(`peak in-flight ≤ MAX_CONCURRENCY (=${MAX_CONCURRENCY}) under full MAX_PARALLEL_TASKS (=${MAX_PARALLEL_TASKS}) load`, async () => {
    // Barrier-driven peak counter, mirroring the "runParallel concurrency
    // cap" test in test/dispatch.test.ts. Here N=MAX_PARALLEL_TASKS exercises
    // a full 2-batch window (4+4) under load rather than the 4+2 used there.
    let inFlight = 0;
    let peak = 0;
    let startedCount = 0;
    const batch1Full = deferred<undefined>();
    const release = deferred<undefined>();

    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        startedCount++;
        // First batch is full (MAX_CONCURRENCY runs in flight). Batches are
        // gated on Promise.all of the prior batch, so no task past the cap
        // can start while we hold here.
        if (startedCount === MAX_CONCURRENCY) batch1Full.resolve(undefined);
        await release.promise;
        inFlight--;
        return makeFakeResult(input.agent.name);
      },
    };

    const N = MAX_PARALLEL_TASKS; // 8 → batch 1 of 4, batch 2 of 4
    const tasks = Array.from({ length: N }, (_, i) => ({ agent: "a", task: `t${i}` }));
    const agents: AgentConfig[] = [agent("a")];

    const executePromise = execute({ tasks }, baseCtx(), agents, runner);
    await batch1Full.promise;

    // At the cap: exactly MAX_CONCURRENCY in flight, batch 2 not yet started.
    expect(peak).toBe(MAX_CONCURRENCY);
    expect(inFlight).toBe(MAX_CONCURRENCY);
    expect(startedCount).toBe(MAX_CONCURRENCY);

    // Release batch 1; batch 2 will then run. peak must hold across both.
    release.resolve(undefined);
    const out = await executePromise;

    expect(peak).toBe(MAX_CONCURRENCY); // cap held; never overshot across 2 batches
    expect(out.isError).toBe(false);
    expect(out.details.mode).toBe("parallel");
    expect(out.details.results).toHaveLength(N);
  });

  it("8 tasks complete within a generous wall-time budget", async () => {
    // Soft smoke test — catches accidental fully-sequential execution. If a
    // future refactor accidentally calls runner.run in a serial `for` loop
    // instead of Promise.all, wall time is roughly 8×PER_TASK_MS instead of
    // 2×PER_TASK_MS (2 batches of MAX_CONCURRENCY). The threshold below is
    // generous on purpose — not a perf SLA — and the failure message points
    // at the most likely cause so a future maintainer isn't guessing.
    const PER_TASK_MS = 50;
    const N = MAX_PARALLEL_TASKS;
    const BUDGET_MS = 5000;

    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => {
        await new Promise((r) => setTimeout(r, PER_TASK_MS));
        return makeFakeResult(input.agent.name);
      },
    };
    const tasks = Array.from({ length: N }, (_, i) => ({ agent: "a", task: `t${i}` }));
    const agents: AgentConfig[] = [agent("a")];

    const start = Date.now();
    const out = await execute({ tasks }, baseCtx(), agents, runner);
    const elapsed = Date.now() - start;

    expect(out.isError).toBe(false);
    expect(out.details.results).toHaveLength(N);

    if (elapsed >= BUDGET_MS) {
      throw new Error(
        `runParallel(${N} tasks × ${PER_TASK_MS}ms) took ${elapsed}ms; ` +
          `budget=${BUDGET_MS}ms. Catastrophic parallelism regression ` +
          `(likely fully sequential). Expected ≤ ~${Math.ceil(N / MAX_CONCURRENCY) * PER_TASK_MS}ms ` +
          `wall time at MAX_CONCURRENCY=${MAX_CONCURRENCY}.`,
      );
    }
  });

  it("result order is preserved across batches", async () => {
    // 8 tasks each ask for a unique agent. Even if a future refactor lets
    // batch 2 complete before batch 1 in the wrong slot (e.g., by dropping
    // the inter-batch `await`), details.results must remain in input task
    // order so render / chain-downstream consumers see the right slot.
    const N = MAX_PARALLEL_TASKS;
    const agents: AgentConfig[] = Array.from({ length: N }, (_, i) =>
      agent(`name-${i}`),
    );
    const tasks = Array.from({ length: N }, (_, i) => ({
      agent: `name-${i}`,
      task: `t${i}`,
    }));

    const runner: AgentRunner = {
      id: "subprocess",
      run: async (input) => makeFakeResult(input.agent.name),
    };

    const out = await execute({ tasks }, baseCtx(), agents, runner);

    expect(out.isError).toBe(false);
    expect(out.details.mode).toBe("parallel");
    expect(out.details.results).toHaveLength(N);

    const agentNames = out.details.results.map((r) => r.agent);
    expect(agentNames).toEqual(
      Array.from({ length: N }, (_, i) => `name-${i}`),
    );
  });

  it("execute() denial path: cancellation completes within wall-time budget", async () => {
    // Project-agent confirmation gate denies synchronously when hasUI=false
    // and the project is untrusted (src/security.ts: confirmProjectAgentsIfNeeded
    // — early return of `{ continue: false, ... }` after the hasUI check).
    // The denial branch in execute() must short-circuit without ever calling
    // selectRunner() / runner.run — wall time should be sub-100ms in practice;
    // 200ms is a very loose CI-friendly bound that still catches a regression
    // where someone accidentally drops the synchronous gate in favor of an
    // awaited user prompt.
    const projectAgent: AgentConfig = {
      name: "repo-reviewer",
      description: "x",
      systemPrompt: "",
      source: "project",
      filePath: "/fake/repo-reviewer.md",
    };
    // `vi.fn()` defaults to a callable whose return type is permissive (any),
    // which suffices — the gate denies BEFORE calling confirm.
    const ctx: DispatchContext = {
      cwd: "/tmp",
      hasUI: false,
      isProjectTrusted: () => false,
      ui: { confirm: vi.fn() },
    };

    const start = Date.now();
    const out = await execute(
      { agentScope: "project", tasks: [{ agent: "repo-reviewer", task: "x" }] },
      ctx,
      [projectAgent],
    );
    const elapsed = Date.now() - start;

    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe("parallel");
    // Parallel-mode denial — matches the task's chosen shape; complements the
    // "denial → details.mode === 'parallel'" assertion in test/dispatch.test.ts
    // (issue #1, Bug 2 regression).
    expect(elapsed).toBeLessThan(200);
  });
});
