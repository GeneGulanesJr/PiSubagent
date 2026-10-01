# 0004. Programmatic agent definitions: `subagent_save` upsert policy + bundled-shadow sync

## Status

Accepted (2026-10-01)

## Context

Dispatch was dynamic (every `subagent` call re-discovers agents from disk),
but definitions were static: nothing in the extension could write an agent
`.md`, so the parent LLM had to hand-write files through generic file tools —
no validation, no dedup, no awareness of shadowing. Meanwhile the documented
override workflow ("drop a same-named `.md` in `~/.pi/agent/agents/`") had a
staleness trap: once a user shadowed a bundled agent, a package update to the
bundled `.md` would never reach their copy, silently and forever.

Owner decisions scoping this feature: build save/update **and** bundled-sync;
minor changes auto-apply, major changes require explicit intent
(`overwrite: true`) rather than a UI prompt (which would block headless runs).

## Decision

### `subagent_save` — upsert with a minor/major policy

- Definitions remain plain agent `.md` files in the directories
  `discoverAgents` already reads. No second state format, no new precedence.
- **Create** when the target file is missing. Creating under a **bundled**
  name is blocked once (`overwrite: true` records the intentional shadow);
  cross-scope name collisions are allowed with a scope-aware note (a user
  copy is _live_ under `agentScope: 'user'`, shadowed under `'both'` —
  blocking it would be wrong under the default scope).
- **Minor updates auto-apply**: only description changed, or the prompt diff
  is ≤ 20% of lines (line-level LCS ratio after text normalization; tools
  compare as a set, frontmatter semantically).
- **Major updates block**: any `tools`/`model`/`tier`/`thinkingLevel` change,
  or prompt ratio > 20%. The error lists the diff and the remediation
  (`overwrite: true` or a new name); the tool description tells the LLM that
  `blocked` is expected behavior, not a retryable failure.
- **Serialization is defensive**: every frontmatter scalar is double-quoted
  (the upstream parser is real YAML — `description: true`/`2024` re-type as
  non-strings and the loader silently drops the agent), the written file is
  re-parsed to verify the round trip, and on failure the previous content is
  **restored** (update path) or the file removed (create path). Unknown
  frontmatter keys are preserved across updates.
- **Writes are project-safe**: project scope requires `ctx.isProjectTrusted()`
  and always targets `findNearestProjectAgentsDir(cwd) ?? <cwd>/.pi/agents`.
  Writing blind to `<cwd>/.pi/agents` would shadow a repo-root `.pi/agents`
  for every dispatch from a subdirectory (discovery loads only the _nearest_
  project agents dir). There is deliberately no `cwd` override — that would
  be an arbitrary-directory write primitive.

### Bundled-shadow sync — provenance-gated 3-way merge

- Shadows created by the tool record a base snapshot
  (`~/.pi/agent/pisubagent/bases/<name>.json` — JSON so snapshots can't be
  discovered as live agents) containing the **bundled file's normalized
  content at capture time** and its hash. Snapshotting the shadow's own
  content instead would make every rebase overwrite intentional overrides
  with stock bundled text.
- On each dispatch (and save), sync compares the current bundled file to the
  base: unchanged → silent; untouched copies → fast-forward; minor user
  edits + clean 3-way merge → rebase (user's edits preserved on top of the
  new bundled version, base refreshed); major edits, settings changes, or
  merge conflicts → advisory only, the file is never auto-touched.
- Hand-written shadows have no snapshot and are never auto-touched —
  PiSubagent only rebases files it can provenance. Orphaned snapshots
  (shadow deleted by hand) are skipped silently and surfaced by
  `/pisubagent-doctor`.
- All hashing and diffing runs on normalized text (CRLF working-tree copies
  must not flip minor → major); `.gitattributes` forces LF for shipped
  files, so normalized hashing also makes line-ending churn a non-event.
- Sync runs before discovery in both tools, wrapped so its failure degrades
  to a skipped note — it can never fail a dispatch. `withFileMutationQueue`
  serializes writes per process; across processes racing writers produce
  deterministic identical bytes for fast-forward/rebase, and divergent
  states degrade to advisories.

## Consequences

### Positive

- The parent LLM can build a project's agent fleet in-session; tuned agents
  persist and are editable in place without regressing the user's manual
  tweaks.
- Bundled agents can evolve across releases without stranding overrides.
- Hardening shipped alongside: `loadAgentsFromDir` no longer bricks all
  dispatches on one malformed file (pre-existing bug), and the bundled dir
  resolution bug (`../../agents` → never loaded in any layout) is fixed and
  pinned by a regression test.

### Negative

- ~700 LOC of new diff/merge/store/sync code plus its test surface; the LCS
  and 3-way merge are hand-rolled (the upstream `diff`/`yaml` packages are
  transitive deps — importing them directly would be a phantom dependency).
- Cross-process sync races degrade to advisories rather than being
  prevented; acceptable because the auto-apply paths are idempotent.
- A persistence-injection vector exists in principle: subagent output could
  coax the parent into saving an agent. Mitigations: tool calls are visible
  to the user, `overwrite` friction gates replacements and bundled shadows,
  and user-scope writes affect every project — documented here as an
  accepted risk.

### Alternatives considered

- **Fast-forward + advisory only** (no rebase): would delete the entire
  diff/merge module and still honor "never lose user edits", but the owner
  explicitly wanted minor edits to auto-rebase — declined.
- **UI confirmation for major changes**: blocks headless/no-UI runs and
  interrupts the agent loop; the `overwrite` flag gives the same protection
  asynchronously (the human sees the blocked result either way).
- **Recording only a base hash** (no content snapshot): insufficient — a 3-way
  rebase needs the base text.
- **Per-dispatch model/tier inline objects** (inline one-off agents): a
  separate, larger dispatch-schema change; explicitly out of scope here.
