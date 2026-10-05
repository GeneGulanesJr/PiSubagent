---
name: subagent-delegation
description: Decide WHEN to spawn Pi `subagent` dispatches — net-benefit test, good/poor delegation candidates, 0–1 subagent default, parallel fan-out rules. Load when unsure whether to delegate a task to a subagent, when tempted to fan out multiple agents, or when the user mentions delegation policy.
---

# Subagent Delegation Policy

Canonical text: `docs/delegation-policy.md` (ADR-0006). Condensed rules:

## The test

Spawn a subagent **only for clear net benefit** — not because the task is
large or a subagent is available. Before dispatching, check:

1. Can I complete this efficiently with context I already have? → do it
   myself.
2. Is the work genuinely independent (no continuous back-and-forth with my
   own in-flight changes)?
3. Will the result be much smaller than the context the work needs?
4. Is parallelism actually useful (independent + concurrent), or am I
   splitting one sequential task for its own sake?
5. Is this trivial (a few tool calls)? → no agent.

## Good / poor candidates

| Good (delegate)                          | Poor (do it yourself)                    |
| ---------------------------------------- | ---------------------------------------- |
| Repo/codebase exploration                | Small edits                              |
| Independent research/investigation       | Simple bug fixes                         |
| Performance profiling/analysis           | Straightforward refactors                |
| Security review                          | Tasks needing live implementation knowledge |
| Finding usages/dependencies              | Work requiring repeated context handoff  |
| Independent code review                  |                                          |
| Tests for already-defined behavior       |                                          |
| Comparing alternative implementations    |                                          |

## Defaults

- **Main agent first. Subagent only when justified.** If uncertain, do NOT
  spawn.
- Prefer **0–1 subagents**; parallel fan-out only for genuinely independent
  work.
- "Spawn subagents if needed" from the user is **permission, not a
  requirement** — still apply the test.
- Multiple subagents need clearly distinct, minimally overlapping
  responsibilities.
- Context isolation ≠ token savings: a subagent can increase total usage. The
  point is isolation, parallelism, and concise summarized findings.

## Enforcement in the tool

`runParallel` appends a one-line, non-blocking policy note to results with
more than `POLICY_PARALLEL_WARN` (2) tasks. It never blocks a dispatch.
