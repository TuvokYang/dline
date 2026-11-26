# Changelog

## [Unreleased]

### Added
- Z.ai GLM models now execute tool calls written as `<tool_call>` markers in the reply text instead of printing the call as ordinary text.
- The environment details block now includes a Workspace Recovery section that tells the model whether checkpoints are enabled.

### Fixed
- Fixed models treating project-internal operations such as dependency installs as hard-stop external operations, which stalled tasks even under git or checkpoint recovery.
- Fixed API Rate History staying on its loading state for long Tasks: window reads now stop at a round budget, so very long histories answer before the Webview timeout and extra revisions of a round no longer shrink history coverage.
- Fixed capability switches being pruned as orphans when a resource scan was incomplete or scopes stored keys in different formats.
- Fixed capability panels occasionally stalling because a JSONL lock file stayed behind after a failed ownership read, leaving later writes waiting.
- Fixed the task panel title not matching the latest TODO progress.
- Fixed collapsed subagent rows reporting 0/N tools instead of the real active count.
