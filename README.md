# pisubagent

Pi subagent tool. Single command, three modes.

## Install

`pi install git:github.com/genegulanesjr/PiSubagent` (after pushing to GitHub).

## Use

Ask Pi to use the `subagent` tool:

- **Single**: `subagent(agent: "scout", task: "find auth code")`
- **Parallel**: `subagent(tasks: [{agent:"scout", task:"find models"}, {agent:"scout", task:"find providers"}])`
- **Chain**: `subagent(chain: [{agent:"scout", task:"..."}, {agent:"planner", task:"...{previous}..."}])`

## Built-in agents

- `scout` (Haiku, read-only) — fast recon
- `planner` (Sonnet, read-only) — implementation plans
- `reviewer` (Sonnet, read-only) — code review
- `worker` (Sonnet, full tools) — general implementation

Override by dropping a same-named `*.md` in `~/.pi/agent/agents/`.

## License

MIT
