# Changelog

## [Unreleased]

### Added
- Z.ai GLM models now execute tool calls written as `<tool_call>` markers in reply text instead of printing them as prose.
- The environment details block now includes a Workspace Recovery section showing whether checkpoints are enabled.

### Fixed
- Fixed completed read-only tool rounds occasionally failing to collapse into activity folds and splitting adjacent fold blocks.
- Fixed checkpoint divider rows leaving blank trailing space to the right of shifted Compare/Restore buttons.
- Fixed queued and steering inputs being blocked, delayed, or falsely rejected as full while a task is working or compacting, with clearer refusal feedback.
- Fixed TaskHeader cumulative input token counts undercounting on very long tasks, and preserved the legacy-import degraded marker on read-only history opens.
- Fixed resuming very long tasks timing out or crashing the extension host with out-of-memory errors.
- Fixed restoring a checkpoint from a history or unlocked view timing out, and surfaced an immediate read-only notice when another window holds the lock.
- Fixed context or rate-metrics compaction on one long task blocking new tasks and panel refreshes across the workspace.
- Fixed task resume and state updates clearing global Rules, Workflows, Skills, and Subagents lists.
- Fixed models treating project-internal operations such as dependency installs as hard-stop external operations that repeatedly stalled tasks.
- Fixed API Rate History staying stuck on loading or timing out on long tasks.
- Fixed capability switches being pruned as orphans after incomplete scans or differing scope key formats.
- Fixed capability panels occasionally stalling when a JSONL lock file remained after a failed read.
- Fixed the task panel title not matching the latest TODO progress.
- Fixed collapsed subagent rows reporting 0/N tools instead of the real active count.
