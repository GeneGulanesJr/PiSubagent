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

## Choosing MiniMax M3.1 Flash (`tier: "cheap"`)

Early, mostly third-party evidence — a starting heuristic. Full text:
`docs/delegation-policy.md`.

- **Use for:** well-scoped bug fixes with a test/build to verify; refactors,
  renames, mechanical changes; self-contained front-end prototyping; docs,
  comments, READMEs; many-tool-call agent loops; navigating/summarizing a large
  codebase; high-volume repetitive work ($0.15 in / $0.60 out per 1M tokens).
- **Do NOT use for:** code or security review (misses known problems);
  timing/state-heavy logic (plausible code, runtime errors); hard debugging or
  architecture; web research or factual lookups (confidently wrong); anything
  costly with no automated check.
- **Rules:** verify output with tests/build/lint; reasoning effort `low` or
  `medium` for routine edits (default max is ~12x slower); thinking cannot be
  turned off; 512K context for everyday work; cross-check claimed quotes,
  figures and files; if it wanders, stalls or needs repeated approvals, switch
  to a stronger model.
- **Fallback:** it fails verification twice on the same task -> escalate to a
  stronger model, do not retry.

## Choosing GLM-5.3 Flash (`zai/glm-5.3-flash`, tier `thinking`)

Early, mostly vendor benchmarks — a starting heuristic. Not the full GLM-5.3
(~10x pricier). Full text: `docs/delegation-policy.md`.

- **Use for:** high-volume coding/agentic work ($0.15 in / $0.50 out per 1M
  tokens); multi-step tool use (recovers from errors, ignores tool bait); long
  iterative sessions; Claude-Code-style harnesses; screenshots/charts/PDFs/UI
  (natively multimodal); frontend/game/3D; bulk first-pass security scans.
- **Do NOT use for:** hard academic-style reasoning; final security review (found
  34 of 100 known vulnerabilities); broad factual recall (no evidence);
  costly work with no automated check.
- **Rules:** no "think nothing" mode - set `reasoning_effort` low/medium for
  routine edits; speed depends on the provider (Z.ai ~49 tok/s vs 195-273 on
  Baseten/FriendliAI/Databricks); never send sensitive or customer data to the
  first-party API (no DPA or zero retention, PRC law); verify with tests/build/lint.
- **Fallback:** fails verification twice on the same task -> escalate to a
  stronger model, do not retry.

## Enforcement in the tool

`runParallel` appends a one-line, non-blocking policy note to results with
more than `POLICY_PARALLEL_WARN` (2) tasks. It never blocks a dispatch.
