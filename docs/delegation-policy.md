# Subagent Delegation Policy

Use subagents **only when they provide a clear net benefit**. Do not spawn a
subagent merely because the task is large, complex, or because a subagent
could technically perform part of it.

Before spawning any subagent, evaluate:

1. **Can I complete this efficiently with the context I already have?**
   - If yes, do it myself.
   - Do not delegate simply to "save context."

2. **Is the delegated work genuinely independent?**
   - Good candidates:
     - Repository/codebase exploration
     - Independent investigation or research
     - Performance profiling/analysis
     - Security review
     - Finding usages/dependencies
     - Independent code review
     - Writing or validating tests for already-defined behavior
     - Comparing alternative implementations
   - Poor candidates:
     - Small edits
     - Simple bug fixes
     - Straightforward refactors
     - Tasks requiring continuous knowledge of the current implementation
     - Work where I would need to repeatedly communicate context back and forth

3. **Will the subagent's output be substantially smaller than the context it
   would need to perform the task?**
   - Prefer delegation when a large investigation can be reduced to a concise
     result.
   - Avoid delegation when the subagent would need extensive project context
     and its output will require substantial review or correction.

4. **Is parallelism actually useful?**
   - Spawn multiple subagents only when their tasks are genuinely independent
     and can run concurrently.
   - Do not split one sequential task into multiple agents just for the sake
     of using subagents.

5. **Avoid subagent overhead for trivial work.**
   - Do not spawn an agent for a task that can reasonably be completed in a
     few tool calls or a small number of edits.

## Default behavior

**Main agent first. Subagent only when justified.**

If uncertain, do NOT spawn a subagent.

Before spawning, briefly state internally:

> "Delegating because [specific reason]. The subagent will [bounded task], and
> I expect its result to materially improve [context efficiency / parallelism /
> investigation quality]."

If you cannot identify a concrete benefit, perform the work yourself.

## Important

Do not confuse **saving the main context window** with **saving tokens**.

A subagent may increase total token usage. Use subagents primarily for:

- context isolation
- parallel independent work
- specialized investigation
- large exploratory tasks whose findings can be summarized

Do not use them merely because they are available.

## When the user explicitly says "spawn subagents"

Treat that as permission, **not a requirement**.

Interpret:

> "Spawn subagents if needed"

as:

> "You may use subagents if your delegation policy determines they provide a
> meaningful net benefit."

If the task is better handled by the main agent, do not spawn one.

## Maximum delegation

Unless the task clearly benefits from parallelization, prefer **0–1
subagents**.

Do not recursively spawn additional subagents unless the task genuinely
requires it.

For multiple subagents, each must have a clearly distinct responsibility with
minimal overlap.

## Final principle

**Optimize for the best result, not maximum agent utilization.**

A task completed cleanly by the main agent with zero subagents is preferable
to a task made more complicated by unnecessary delegation.

---

## Enforcement in PiSubagent

The policy is guidance-first, enforcement-light (ADR-0006):

- **Tool description** (`src/index.ts`) — a condensed version ships in the
  `subagent` tool description, the one delegation-time text every parent model
  reads.
- **`POLICY_PARALLEL_WARN = 2`** (`src/dispatch/limits.ts`) — parallel
  dispatches with more than 2 tasks are allowed (up to `MAX_PARALLEL_TASKS`)
  but `runParallel` appends a one-line, non-blocking policy note to the
  parent-facing result. It never blocks a dispatch or changes `isError`.
- **Skill** (`skills/subagent-delegation/SKILL.md`) — loaded on demand when a
  parent model is deciding whether to delegate.

A hard `justification` parameter on the tool was considered and deferred:
schema friction for every caller without proven benefit. Revisit if soft
guidance proves insufficient.
