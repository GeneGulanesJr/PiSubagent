import { describe, it, expect, vi } from "vitest";
import { confirmProjectAgentsIfNeeded } from "../src/security.js";
import type { SubagentParams, AgentConfig } from "../src/types.js";

type ConfirmFn = ReturnType<typeof vi.fn> & { mockResolvedValue: (v: boolean) => unknown };

function makeCtx(opts: { trusted?: boolean; hasUI?: boolean; confirmValue?: boolean }) {
  const confirm = vi.fn().mockResolvedValue(opts.confirmValue ?? true);
  return {
    ctx: {
      cwd: "/tmp",
      hasUI: opts.hasUI ?? true,
      isProjectTrusted: () => opts.trusted ?? false,
      ui: { confirm },
    },
    confirm: confirm as ConfirmFn,
  };
}

function makeAgent(name: string, source: "user" | "project" | "bundled"): AgentConfig {
  return { name, description: "x", systemPrompt: "", source, filePath: `/fake/${name}.md` };
}

const baseParams: SubagentParams = { agent: "scout", task: "x" };

describe("confirmProjectAgentsIfNeeded", () => {
  it("continues without prompting when scope is 'user'", async () => {
    const { ctx, confirm } = makeCtx({});
    const decision = await confirmProjectAgentsIfNeeded(
      baseParams,
      [makeAgent("scout", "project")],
      ctx as never,
    );
    expect(decision.continue).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips prompt when project is trusted", async () => {
    const { ctx, confirm } = makeCtx({ trusted: true });
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: "both" },
      [makeAgent("scout", "project")],
      ctx as never,
    );
    expect(decision.continue).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts on untrusted project and cancels when user declines", async () => {
    const { ctx, confirm } = makeCtx({ confirmValue: false });
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: "both" },
      [makeAgent("scout", "project")],
      ctx as never,
    );
    expect(decision.continue).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("honors confirmProjectAgents: false to skip the prompt", async () => {
    const { ctx, confirm } = makeCtx({});
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: "project", confirmProjectAgents: false },
      [makeAgent("scout", "project")],
      ctx as never,
    );
    expect(decision.continue).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not prompt when only user-level agents are requested at scope 'both'", async () => {
    const { ctx, confirm } = makeCtx({});
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: "both" },
      [makeAgent("scout", "user")],
      ctx as never,
    );
    expect(decision.continue).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("collects project agents from parallel tasks and chain steps", async () => {
    const { ctx, confirm } = makeCtx({ confirmValue: false });
    const agents = [
      makeAgent("scout", "user"),
      makeAgent("repo-reviewer", "project"),
      makeAgent("repo-planner", "project"),
    ];
    const decision = await confirmProjectAgentsIfNeeded(
      {
        agentScope: "both",
        tasks: [
          { agent: "scout", task: "a" },
          { agent: "repo-reviewer", task: "b" },
        ],
        chain: [{ agent: "repo-planner", task: "c" }],
      },
      agents,
      ctx as never,
    );
    expect(decision.continue).toBe(false);
    expect(decision.requestedProjectAgents.map((a) => a.name).sort()).toEqual([
      "repo-planner",
      "repo-reviewer",
    ]);
  });

  it("blocks (no crash) when no UI is available on untrusted project", async () => {
    const { ctx, confirm } = makeCtx({ hasUI: false });
    const decision = await confirmProjectAgentsIfNeeded(
      { ...baseParams, agentScope: "project" },
      [makeAgent("scout", "project")],
      ctx as never,
    );
    expect(decision.continue).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
