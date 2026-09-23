# PiSubagent Examples

Runnable, copy-and-modify examples for authoring agents and dispatching
work with Pi's `subagent(...)` tool.

## Agents

- [`agents/minimal-agent.md`](./agents/minimal-agent.md) — every frontmatter field (required + optional) with inline annotations and a sample read-only scout body.

## Invocations

- [`invocations/single.md`](./invocations/single.md) — `subagent(agent, task)` for one-shot dispatch when the work is a single, self-contained unit.
- [`invocations/parallel.md`](./invocations/parallel.md) — `subagent(tasks: [...])` for fanning out 3+ independent fixes across separate file sets.
- [`invocations/chain.md`](./invocations/chain.md) — `subagent(chain: [...])` with `{previous}` substitution for scout → planner → worker and review loops.

## How to use these files

1. **Agents:** copy `agents/minimal-agent.md` into your `agents/`
   directory (project-local `.pi/agents/` or `~/.pi/agent/agents/`),
   rename the file and the `name:` field, then edit the body.
2. **Invocations:** copy the fenced `subagent(...)` block into your
   prompt or skill. Replace the `task:` text with your real request;
   keep the structure (chain steps, parallel batch sizes) intact.

## Conventions used in these examples

- File paths are repo-relative unless noted.
- Task text is **self-contained** — subagents have isolated context and
  cannot see your session, so every needed file path and constraint is
  pasted into the task body.
- Model names follow `<family>-<size>-<generation>` (e.g.
  `claude-haiku-4-5`). Omit `model:` to inherit the caller's model.
