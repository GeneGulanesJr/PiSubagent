import type { SubagentParams, AgentConfig } from "./types.js";

export interface ConfirmationDecision {
  continue: boolean;
  /** Project agents that triggered (or would have triggered) the prompt. */
  requestedProjectAgents: AgentConfig[];
  /** Human-readable source label surfaced in the prompt body. */
  sourceDir?: string;
}

function getRequestedAgentNames(params: SubagentParams): string[] {
  const names = new Set<string>();
  if (params.chain) for (const step of params.chain) names.add(step.agent);
  if (params.tasks) for (const t of params.tasks) names.add(t.agent);
  if (params.agent) names.add(params.agent);
  return [...names];
}

/**
 * Gate project-local agents behind an explicit confirmation when the project is
 * untrusted. Order of checks:
 *   1. scope "user" → continue (project agents never loaded)
 *   2. no project agents among the requested names → continue
 *   3. confirmProjectAgents === false → continue (explicit opt-out)
 *   4. project trusted → continue
 *   5. no UI → block (cannot ask)
 *   6. prompt via ctx.ui.confirm; continue only on approval
 */
export async function confirmProjectAgentsIfNeeded(
  params: SubagentParams,
  agents: AgentConfig[],
  ctx: {
    cwd: string;
    hasUI: boolean;
    isProjectTrusted: () => boolean;
    ui: { confirm: (title: string, message: string) => Promise<boolean> };
  },
): Promise<ConfirmationDecision> {
  const scope = params.agentScope ?? "user";
  if (scope === "user") return { continue: true, requestedProjectAgents: [] };

  const requestedNames = new Set(getRequestedAgentNames(params));
  const requestedProjectAgents = agents.filter(
    (a) => requestedNames.has(a.name) && a.source === "project",
  );

  if (requestedProjectAgents.length === 0) {
    return { continue: true, requestedProjectAgents: [] };
  }

  if (params.confirmProjectAgents === false) {
    return { continue: true, requestedProjectAgents };
  }

  if (ctx.isProjectTrusted()) {
    return { continue: true, requestedProjectAgents };
  }

  if (!ctx.hasUI) {
    return { continue: false, requestedProjectAgents };
  }

  const names = requestedProjectAgents.map((a) => a.name).join(", ");
  const sourceDir = "project .pi/agents directory";
  const ok = await ctx.ui.confirm(
    "Run project-local agents?",
    `Agents: ${names}\nSource: ${sourceDir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
  return { continue: ok, requestedProjectAgents, sourceDir };
}
