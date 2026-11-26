# Changelog

## [Unreleased]

### Added
- Z.ai GLM models now execute tool calls written as `<tool_call>` markers in the reply text instead of printing the call as ordinary text.
- The environment details block now includes a Workspace Recovery section that tells the model whether checkpoints are enabled.

### Fixed
- Fixed resuming very long tasks timing out or crashing the extension host with out-of-memory errors by optimizing journal projection and metrics loading, bounding activity hydration and snapshot size, and removing full-table scans and retained history copies on promotion.
- Fixed the Restore button timing out when restoring chat from a history or unlocked task view, and surfaced an immediate read-only notice when another window holds the task lock.
- Fixed context compaction and rate-metrics compaction on one long task blocking the extension host and stalling new tasks and capability panels across the workspace.
- Fixed task resume and full state updates clearing global Rules, Workflows, Skills, and Subagents back to empty maps by combining discovered global capabilities with sparse user overrides.
- Fixed models treating project-internal operations such as dependency installs as hard-stop external operations, which stalled tasks even under git or checkpoint recovery.
- Fixed API Rate History staying on its loading state for long Tasks: window reads now stop at a round budget, so very long histories answer before the Webview timeout and extra revisions of a round no longer shrink history coverage.
- Fixed capability switches being pruned as orphans when a resource scan was incomplete or scopes stored keys in different formats.
- Fixed capability panels occasionally stalling because a JSONL lock file stayed behind after a failed ownership read, leaving later writes waiting.
- Fixed the task panel title not matching the latest TODO progress.
- Fixed collapsed subagent rows reporting 0/N tools instead of the real active count.
