import { spawn as defaultSpawn } from "node:child_process";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentParams, SubagentDetails, Mode, AgentConfig, SingleResult } from "./types.js";
import type { AgentRunner } from "./runner/runner.js";
import { confirmProjectAgentsIfNeeded } from "./security.js";
import { SubprocessRunner } from "./runner/subprocess.js";
import { getFinalOutput, isFailedResult, getResultOutput } from "./output.js";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export function detectMode(params: SubagentParams): Mode | "invalid" {
  const single = Boolean(params.agent && params.task);
  const parallel = (params.tasks?.length ?? 0) > 0;
  const chain = (params.chain?.length ?? 0) > 0;
  const count = Number(single) + Number(parallel) + Number(chain);
  if (count !== 1) return "invalid";
  if (single) return "single";
  if (parallel) return "parallel";
  return "chain";
}

export function buildInvalidParamsError(agents: AgentConfig[]): {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError: true;
} {
  const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
  return {
    content: [
      {
        type: "text",
        text: `Invalid parameters. Provide exactly one mode: {agent, task} OR {tasks: [...]} OR {chain: [...]}. Available agents: ${available}`,
      },
    ],
    details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
    isError: true,
  };
}

export interface DispatchContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  ui: { confirm: (title: string, message: string) => Promise<boolean> };
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
}

export interface ToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}

function baseDetails(mode: Mode, params: SubagentParams, projectAgentsDir: string | null): Omit<SubagentDetails, "results"> {
  return { mode, agentScope: params.agentScope ?? "user", projectAgentsDir };
}

function parentDefaults(ctx: DispatchContext): { parentModel?: string; parentThinkingLevel?: ThinkingLevel } {
  return {
    parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    parentThinkingLevel: ctx.thinkingLevel,
  };
}

export function selectRunner(): AgentRunner {
  // v1: always subprocess. v2 swaps via config gating (see spec § AgentRunner).
  return new SubprocessRunner({ spawnFn: defaultSpawn });
}

/**
 * Mode orchestrator. `agents` is the resolved discovery list (from index.ts),
 * already filtered to the agents this dispatch needs. `runnerOverride` lets
 * tests inject a SubprocessRunner with a fake spawn (ESM bindings can't be
 * monkey-patched).
 */
export async function execute(
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
  runnerOverride?: AgentRunner,
): Promise<ToolResultLike> {
  const mode = detectMode(params);
  if (mode === "invalid") return buildInvalidParamsError(agents);

  const decision = await confirmProjectAgentsIfNeeded(params, agents, ctx);
  if (!decision.continue) {
    return {
      content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
      details: { ...baseDetails("single", params, null), results: [] },
      isError: true,
    };
  }

  const runner = runnerOverride ?? selectRunner();
  const lookup = (name: string): AgentConfig =>
    agents.find((a) => a.name === name) ?? {
      name,
      description: "",
      systemPrompt: "",
      source: "bundled",
      filePath: "",
    };

  if (mode === "single") return runSingle(runner, params, ctx, agents, lookup);
  if (mode === "parallel") return runParallel(runner, params, ctx, agents, lookup);
  return runChain(runner, params, ctx, agents, lookup);
}

export async function runSingle(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
  lookup: (name: string) => AgentConfig,
): Promise<ToolResultLike> {
  const agent = lookup(params.agent!);
  const result = await runner.run(
    {
      agent,
      task: params.task!,
      cwd: params.cwd ?? ctx.cwd,
      ...parentDefaults(ctx),
    },
    undefined,
  );
  return {
    content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
    details: { ...baseDetails("single", params, null), results: [result] },
    isError: isFailedResult(result),
  };
}

export async function runParallel(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
  lookup: (name: string) => AgentConfig,
): Promise<ToolResultLike> {
  const tasks = params.tasks!;
  if (tasks.length > MAX_PARALLEL_TASKS) {
    return {
      content: [
        { type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
      ],
      details: { ...baseDetails("parallel", params, null), results: [] },
      isError: true,
    };
  }
  const allResults: SingleResult[] = await Promise.all(
    tasks.map((t) =>
      runner.run({
        agent: lookup(t.agent),
        task: t.task,
        cwd: t.cwd ?? ctx.cwd,
        ...parentDefaults(ctx),
      }),
    ),
  );
  const successCount = allResults.filter((r) => !isFailedResult(r)).length;
  const summaries = allResults.map((r) => {
    const status = isFailedResult(r) ? "failed" : "completed";
    const body = getResultOutput(r);
    return `### [${r.agent}] ${status}\n\n${body}`;
  });
  return {
    content: [
      {
        type: "text",
        text: `Parallel: ${successCount}/${allResults.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
      },
    ],
    details: { ...baseDetails("parallel", params, null), results: allResults },
    isError: successCount < allResults.length,
  };
}

export async function runChain(
  runner: AgentRunner,
  params: SubagentParams,
  ctx: DispatchContext,
  agents: AgentConfig[],
  lookup: (name: string) => AgentConfig,
): Promise<ToolResultLike> {
  const steps = params.chain!;
  const results: SingleResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const resolvedTask = step.task.replace(/\{previous\}/g, previousOutput);
    const result = await runner.run({
      agent: lookup(step.agent),
      task: step.task,
      cwd: step.cwd ?? ctx.cwd,
      resolvedTask,
      ...parentDefaults(ctx),
    });
    results.push(result);

    if (isFailedResult(result)) {
      return {
        content: [
          {
            type: "text",
            text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}`,
          },
        ],
        details: { ...baseDetails("chain", params, null), results },
        isError: true,
      };
    }
    previousOutput = getFinalOutput(result.messages);
  }

  const final = results[results.length - 1];
  return {
    content: [{ type: "text", text: getFinalOutput(final.messages) || "(no output)" }],
    details: { ...baseDetails("chain", params, null), results },
  };
}
