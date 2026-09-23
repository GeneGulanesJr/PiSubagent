# Parallel-Mode Invocation

`parallel` mode dispatches **multiple independent agents** in a single
`subagent(...)` call. Tasks are bounded (up to 8 per call, 4 concurrent)
and only parallelize when their file sets don't overlap.

## When to use it

Use `parallel` when you have **3+ truly independent problems** — for
example, fixing unrelated test files, or patching separate subsystems
that share no state. If the failures might share a root cause,
investigate together first; parallel calls hide that signal.

## Invocation

```js
// Four unrelated test files failed in CI; each lives in its own module
// and touches different files. Fan them out, then merge results.
subagent(
  tasks: [
    {
      agent: "worker",
      task: "Fix the failing test `src/subprocess.test.ts::spawn_reports_nonzero_exit`. Read the test, the failure log (pasted below), and patch only this file.\n\nFailure:\nAssertionError: expected exit code to be 1, got null"
    },
    {
      agent: "worker",
      task: "Fix the failing test `src/agents/loader.test.ts::rejects_missing_frontmatter`. Patch only `src/agents/loader.test.ts`.\n\nFailure:\nError: expected loader to throw on empty frontmatter, but it returned an empty agent object"
    },
    {
      agent: "worker",
      task: "Fix the failing test `src/chain.test.ts::aborts_on_step_failure`. Patch only `src/chain.test.ts`.\n\nFailure:\nAssertionError: chain continued past a worker step that returned BLOCKED"
    },
    {
      agent: "worker",
      task: "Fix the failing test `src/parallel.test.ts::respects_max_concurrency`. Patch only `src/parallel.test.ts`.\n\nFailure:\nAssertionError: observed concurrency 5, expected ≤ 4"
    }
  ]
)
```

## Anatomy

- `tasks:` — array of `{agent, task}` objects. Order doesn't imply order
  of execution; tasks run concurrently up to the concurrency limit.
- `agent:` per task — any agent the dispatcher knows about. Mixing agents
  in one batch is fine (e.g. one `scout`, two `worker`s, one `reviewer`).
- `task:` per task — must be self-contained per the same rules as `single`.

## Red flags

- **Never** dispatch two `worker`s that edit the same file in parallel.
- **Never** parallelize failures that share a root cause — investigate
  together first.
- **Always** spot-check the merged diff after a parallel batch; the
  callers' sessions don't see each other's edits.
