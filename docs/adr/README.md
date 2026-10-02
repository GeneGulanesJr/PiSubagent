# Architecture Decision Records

This directory captures significant architectural and design decisions made during the PiSubagent project. Each record follows the [Michael Nygard ADR format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## Index

| Number                                      | Title                                                               | Status   |
| ------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](0001-per-batch-concurrency-cap.md)   | Per-batch concurrency cap for runParallel                           | Accepted |
| [0002](0002-truncate-parallel-output.md)    | Truncate parallel/chain output to PER_TASK_OUTPUT_CAP               | Accepted |
| [0003](0003-streaming-progress-throttle.md) | Streaming progress with per-agent latest message at 150ms throttle  | Accepted |
| [0004](0004-agent-save-and-bundled-sync.md) | Programmatic agent definitions: subagent_save + bundled-shadow sync | Accepted |
| [0005](0005-provider-concurrency-caps.md)   | Provider-scoped concurrency caps for parallel dispatch              | Accepted |

## Writing a new ADR

1. Use the structure from any existing ADR (Status / Context / Decision / Consequences).
2. Use the next available number.
3. Update the index above.
