# Chain-Mode Invocation

`chain` mode runs agents **sequentially**, threading each step's final
output into the next step's task via the `{previous}` placeholder. A
failing step aborts the chain — you don't get a half-built pipeline.

## When to use it

Use `chain` whenever step N needs step N-1's output. The canonical
shapes are `scout → planner → worker` (plan then build) and
`worker → reviewer → worker` (build, review, fix).

## Invocation

```js
// scout → planner → implementer: turn a vague ask into a working patch.
subagent(
  chain: [
    {
      agent: "scout",
      task: "Find all code relevant to: $@\nReturn file paths with line ranges, exported symbols, and a one-paragraph architecture summary."
    },
    {
      agent: "planner",
      task: "Create an implementation plan for: $@\n\nContext from scout:\n{previous}\n\nConstraints:\n- No new dependencies.\n- Touch the smallest possible surface.\n- List each step with exact file paths and a one-line verification."
    },
    {
      agent: "worker",
      task: "Implement this plan verbatim:\n{previous}\n\nReturn: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED.\nInclude exact files changed and any concerns."
    }
  ]
)
```

## Anatomy

- `chain:` — array of `{agent, task}` steps, executed top-to-bottom.
- `{previous}` in a step's `task` — replaced with the prior step's final
  assistant output. Omit it in the first step (there is no `{previous}`).
- **`$@`** — the original user request that kicked off the chain. Useful
  to repeat verbatim so the later steps still see the original ask.
- A step that returns anything other than a success shape stops the
  chain; the remaining steps do not run.

## Variants

```js
// worker → reviewer → worker: implement, review, apply fixes.
subagent(
  chain: [
    { agent: "worker",   task: "Implement: $@" },
    { agent: "reviewer", task: "Review these changes:\n{previous}" },
    { agent: "worker",   task: "Apply this review feedback:\n{previous}" }
  ]
)
```

## Red flags

- **Never** put `{previous}` in the first step of a chain.
- **Never** build a chain whose steps could run independently — that's
  a `parallel` batch instead.
- **Never** silently swallow a `BLOCKED` from a chain step; re-dispatch
  with more context or escalate.
