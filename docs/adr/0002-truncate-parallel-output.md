# 0002. Truncate parallel/chain output to PER_TASK_OUTPUT_CAP

## Status

Accepted (2026-09-23, commit `940695e`)

## Context

`PER_TASK_OUTPUT_CAP = 50 * 1024` bytes was exported from `src/dispatch.ts` since the initial release but never enforced. `runParallel` joined raw per-agent output via `getResultOutput()`, letting a single chatty agent produce multi-MB content text. `runChain` substituted `{previous}` with the prior step's raw output, so a 1MB previous step became a 1MB next-step prompt.

## Decision

- `runParallel`: each summary body is passed through `truncateParallelOutput(body, PER_TASK_OUTPUT_CAP)` before joining. `details.results[i].messages` still carries the full untruncated output for downstream consumers.
- `runChain`: `previousOutput` is truncated to `PER_TASK_OUTPUT_CAP` bytes BEFORE substitution.

## Consequences

### Positive

- Bounded memory + bounded prompt-injection surface.
- Truncation marker `[Output truncated: N bytes omitted. Full output preserved in tool details.]` makes the cap visible to the user.
- `truncateParallelOutput` was already implemented in `src/output.ts` and tested in `output.test.ts` — no signature change.

### Negative

- Lossy: user sees only the first 50KB per agent in the parent-facing content text. To see the full output, expand `details.results[i].messages`.

### Alternatives considered

- **Streaming truncation (rejected)**: would require streaming the entire output to the parent token-by-token. Adds complexity for marginal UX gain when PER_TASK_OUTPUT_CAP is 50KB.
- **Hard cap on `messages` array (rejected)**: would lose important context for downstream tools (rendering, summarization). Capping only the joined `content[0].text` is the right granularity.
