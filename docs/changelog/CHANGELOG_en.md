# Changelog

## [Unreleased]

### Added
- Z.ai GLM models now execute tool calls written as `<tool_call>` markers in the reply text instead of printing the call as ordinary text.
- The environment details block now includes a Workspace Recovery section that tells the model whether checkpoints are enabled.

### Fixed
- Fixed models treating project-internal operations such as dependency installs as hard-stop external operations, which stalled tasks even under git or checkpoint recovery.
- Fixed API Rate History staying on its loading state for long Tasks: window reads now stop at a round budget, so very long histories answer before the Webview timeout and extra revisions of a round no longer shrink history coverage.
