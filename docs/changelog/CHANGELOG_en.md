# Changelog

## [0.14.4]

### Added
- Z.ai GLM models now execute tool calls written as `<tool_call>` markers in reply text instead of printing them as prose.
- Hovering the task header now displays the full task text and Task ID.
- The environment details block now includes a Workspace Recovery section showing whether checkpoints are enabled.
- Added GitHub and X project links to the bottom of About and What's New.

### Changed
- GPT-6.2 models on the OpenAI Responses API (OpenAI and ChatGPT Subscription) now send the system prompt in a `developer` input item and inherit it across WebSocket continuations to preserve prompt caching.
- Moved Responses WebSocket transport out of API Format onto an explicit "Use WebSocket transport" option on OpenAI and ChatGPT Subscription Profiles, with legacy profile migration and automatic full-context or HTTP fallback.

### Fixed
- Fixed completed read-only tool rounds occasionally failing to collapse into activity folds and splitting adjacent fold blocks.
- Fixed parallel native tool calls with identical tool name and arguments in the same round being deduplicated and dropped.
- Fixed completion checkpoint hashes failing to attach to their target message row when unsettled tool previews are withdrawn concurrently.
- Fixed checkpoint divider rows leaving blank trailing space to the right of shifted Compare/Restore buttons.
- Fixed queued and steering inputs being blocked, delayed, or falsely rejected as full while a task is working or compacting, with clearer refusal feedback.
- Fixed TaskHeader cumulative input token counts undercounting on very long tasks, and preserved the legacy-import degraded marker on read-only history opens.
- Fixed resuming very long tasks timing out or crashing the extension host with out-of-memory errors.
- Fixed restoring a checkpoint from a history or unlocked view timing out, and surfaced an immediate read-only notice when another window holds the lock.
- Fixed context or rate-metrics compaction on one long task blocking new tasks and panel refreshes across the workspace.
- Fixed task resume and state updates clearing global Rules, Workflows, Skills, and Subagents lists.
- Fixed models treating project-internal operations such as dependency installs as hard-stop external operations that repeatedly stalled tasks.
- Fixed API Rate History timing out on long tasks and returning empty before an opened History task finished hydrating metrics.
- Fixed capability switches being pruned as orphans after incomplete scans or differing scope key formats.
- Fixed capability panels occasionally stalling when a JSONL lock file remained after a failed read.
- Fixed the task panel title not matching the latest TODO progress.
- Fixed collapsed subagent rows reporting 0/N tools instead of the real active count.
- Fixed the chat view failing to return to the live tail after sending replies or steering input.
- Fixed the TaskHeader hover card opening on click-focus or layout shifts and obscuring adjacent header controls.
- Fixed model capability and reasoning-effort defaults drifting, persisted Hosted Search per Profile, and hid Add Tier under flat pricing.
- Fixed custom Profile `modelInfo` overrides without an explicit `id` being discarded when loading Profiles.
- Fixed ChatGPT Subscription WebSocket continuation fallback dropping prior conversation turns instead of resending full context.
