# Single-Mode Invocation

`single` mode dispatches **one** agent with **one** task and returns its
final output. It's the default shape of `subagent(...)` when you omit the
`tasks:` and `chain:` arrays.

## When to use it

Use `single` when the work is a single, self-contained unit and the
caller wants the output back inline. Pair it with a review agent in a
follow-up `single` call when you need a quality gate after the work.

## Invocation

```js
// Read-only recon on a specific module before editing it.
subagent(
  agent: "scout",
  task: "Investigate `src/subprocess.ts` and return: (1) the exact symbols exported, (2) any process-spawn calls and their error-handling paths, (3) tests that cover error paths. Limit output to 300 words."
)
```

## Anatomy

- `agent:` — name of the agent file (without `.md`) under `agents/`,
  or `~/.pi/agent/agents/`, or the project's `.pi/agents/`.
- `task:` — the full task text. The subagent has an **isolated context**
  and cannot see your session, so paste everything it needs: file paths,
  constraints, expected output shape. No "see the plan" hand-waving.

## Tip

If you find yourself calling `single` three or more times in a row where
each call depends on the previous one, switch to `chain` mode instead —
it removes the manual `{previous}` plumbing and aborts on failure.
