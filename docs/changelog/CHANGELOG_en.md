English | [中文版](https://github.com/TuvokYang/Dline/blob/dev/CHANGELOG.md)

# Changelog

## [0.9.4]

### Features
- Parallel tool calls: when enabled, calls in one turn that need no manual approval can run concurrently; calls needing approval are confirmed one at a time, with a configurable maximum. Disabling the feature keeps execution serial
- `use_subagents` accepts up to 32 subagents per call, each with its own agent, API Profile, and timeout; items above the concurrency limit queue instead of being discarded
- Claude Code Profiles support OAuth sign-in and direct Anthropic Messages API requests; Anthropic API-key Profiles can optionally send Claude Code billing attribution, but the provider determines whether usage counts against a subscription
- Anthropic and Claude Code can declare hosted Web Search and Web Fetch independently where supported; actual execution depends on the provider response, and Force Remote does not silently fall back to local tools
- Claude Opus 5.5 is in the built-in model catalog and is the default for Anthropic and Claude Code; availability still depends on the provider account

### Changed
- Subscription usage identifies provider quota windows and snapshot age, and counts daily input/output tokens from Dline's own requests locally; sources without periodic usage polling retain an initial snapshot and manual refresh
- History tasks open in a lightweight, read-only message window while preserving their bound Profile, cross-window lock notice, and saved subagent metrics
- Command logs and shell diagnostics now live under the owning task's temporary directory, with a per-task size budget; commands without a task still use the process temporary directory
- Migration from Cline no longer imports task history that Dline cannot open or resume; settings, rules, workflows, and MCP configuration keep their existing migration paths
- When switching models, readable reasoning from the previous model becomes ordinary context tagged `<prior_model_reasoning>`; opaque reasoning and response IDs are not replayed to the new model, and a model-switch notice is added to the following user turn

### Fixed
- Fixed request-level approval appearing merely because hosted Web capabilities were declared; `Use Web` still governs Dline-owned local Web tools, and legacy hosted-approval snapshots require an explicit Resume only for a matching persisted history tail
- Fixed `generate_image` approvals, rejections, and reopened tasks losing the title, prompt, or image card; rejection makes no provider request
- Fixed replaying reasoning from another protocol as Anthropic thinking after switching providers, which could cause the request to be rejected
- Fixed silent Close Task failures and stale reply drafts appearing after a closed task is reopened
- Fixed duplicate approval/input submissions, accumulated API auto-retry failure cards, and command cards collapsing before streaming output finishes
- Fixed delayed process-listener/log-stream cleanup when commands finish, fail to start, or are cancelled, as well as cross-task background-command cancellation and missing trailing output

## [0.9.3]

### Features
- Expanded OpenAI Codex provider support with dynamic model discovery, OpenAI Responses over HTTP / WebSocket, hosted Web Search, reasoning and Service Tier controls, plus shared account quota, refresh, and rate-limit reset-card actions across Profiles and task input
- Expanded OpenAI / OpenAI Codex image source configuration: OpenAI can use GPT Subscription, GPT API, Independent, or Hosted sources, while Codex can use GPT Subscription, Independent, or Hosted; `gpt-image-2.5` is now the shared default and legacy settings migrate automatically

### Changed
- Usage reporting and error/runtime diagnostics now use independent consent channels; the legacy single telemetry consent is not migrated automatically, and no corresponding journal or remote client is created without consent
- Diagnostic signals now use a bounded local journal and OpenTelemetry Events / Metrics / Traces; Dline targets loopback `127.0.0.1:4318` by default and filters prompts, file contents, command input/output, and credentials before export or delivery
- The provider selector is now generated and grouped from ModelRegistry; the Cline model catalog uses the configured Dline catalog and no longer shows upstream recommendation or promotion cards
- Experimental feature flags now resolve from local configuration instead of requiring sign-in or remote PostHog

### Fixed
- Fixed stale account usage after Profile switches, refreshes that did not update or provide feedback, and incorrect 5-hour/7-day quota summary selection
- Fixed overlapping Usage hover/click overlays, overflowing reset-card layouts, and the double-layer Context Window panel; click details now use a responsive standalone menu
- Fixed subagents failing to converge reliably at timeout or context-pressure limits, which could truncate or lose final results
- Fixed context compaction retry recovery after extension reload, and improved single-pass sendable history, image token estimation, and complete logical-turn boundaries
- Fixed virtual scrolling jitter and incorrect positioning during initial long-chat navigation, streaming follow, upward browsing, window expansion, and container resize
- Fixed Recent routing and completion actions when closing tasks, and scoped View Changes / Explain Changes to the current task's remaining net changes
- Fixed repeated MCP Marketplace refreshes, lost search focus, input unmounting in error states, and incorrect scroll-container scope
- Fixed Total Tokens calculation in task rate charts and placed TPM and RPM on semantically correct independent axes
- Fixed failed or cancelled image generation repeatedly reading deleted temporary previews, and stopped preview errors from exposing absolute host paths
- Foreground command output that exceeds the display limit now shows a clickable link to the complete log file in Chat and Activities
- Fixed overlapping or clipped tool paths, file names, line numbers, and match counts in narrow views, and capped oversized tool response cards
- Command prompts now strictly follow the actual shell reported by the environment, reducing PowerShell, cmd, and POSIX syntax mismatches
- Fixed ignore-policy error cards still referring to the legacy `.clineignore` filename instead of `.agentignore`

## [0.9.2]

### Features
- Activities panel: new Work / Activities tabs that show live task execution, subagent metrics, tool timelines, and retry progress
- Runtime diagnostics: opt-in local runtime telemetry sampling and one-click diagnostic bundle export (the ZIP excludes code, prompts, and credentials)
- Image generation `generate_image`: supports OpenAI independent/hosted image sources and standalone Gemini image profiles
- OpenAI Codex profile OAuth: per-profile ChatGPT browser sign-in (PKCE) with remaining quota shown in the usage bar
- Capability loading tools: `use_skill` split into `load_skill` / `load_workflow` / `load_mcp` for on-demand skill, workflow, and MCP tool metadata
- `kill_command` tool: terminate a specific running command
- Input queue: keep typing while a task runs; messages queue and are delivered at a safe boundary
- Warm terminal pool: standby terminals remove cold-start latency from command execution
- Command execution controls: new `workdirectory` parameter, command timeout and background handoff settings, and project shell environment loading
- `.agentignore` permission attributes: grant access per `-r` read, `-w` write, `-x` execute, and `-s` listing
- Capability scope chain: capability toggles resolve across global / workspace / task scopes, and task-level toggles persist with the task
- Web tools mode control: choose auto, force local, force remote, or off per profile
- API format selector: pick OpenAI Chat / OpenAI Responses / Anthropic Chat when a model supports multiple protocols
- OpenAI service tier selection and task-level runtime controls
- Task rate metrics and charts for API rate, context usage, and historical trends
- Prompt cache health banner with a manual refresh action
- Mode switch, profile switch, and context transition dialogs
- LaTeX rendering with MathJax v4 and Mermaid diagram export as SVG
- Structured API error display with copy action, plus webview hydration progress and failure reporting
- Configurable chat send shortcut

### Changed
- Subagent enhancements: background execution, timeout control, automatic retry of recoverable failures, output budgets, and batch request parsing
- `plan_mode_respond` renamed to `make_plan`; `focus_chain_change` renamed to `change_todo_list`
- Task history moved to SQLite storage, replacing full JSONL scans and importing legacy data automatically
- Prompt architecture refactor: modular i18n registration with variants consolidated into standard / lite profiles
- Context compaction refactor: pass budget constraints with retry replay
- Model discovery unified behind a single ModelRegistry entry point, with model pickers merged into one searchable field
- Settings are no longer projected into VS Code global state; only the canonical source is kept
- Unified ignore rule handling and capped ripgrep CPU usage during workspace walks
- Anthropic support for the 1M long-context beta and automatic reasoning effort fallback

### Fixed
- Fixed task state and lifecycle defects across cancellation, resume, checkpoints, and concurrent panels
- Fixed context compaction accounting, backpressure, retry replay, and interrupted recovery
- Fixed profile switching, admission, and credential isolation consistency across multiple tasks
- Fixed tool result ordering, skipped results after approval rejection, and native tool turn recovery
- Fixed terminal output ordering, background handoff, stalled command recovery, and Windows PowerShell/UTF-8 encoding
- Fixed webview virtual scrolling, streaming diff scroll, button routing, and interaction state mismatches
- Fixed MCP reconnect loops, descriptor watching, and per-task workspace descriptor loading

## [0.9.1]

### Features
- Task-level Profile model switching: ModelSwitcher can isolate API configuration per task and prevent cross-window model/profile contamination
- OpenAI Native / OpenAI Codex model data updates: synchronized official model metadata and added thinking / reasoning configuration support

### Changed
- Agent workflow directory migration: moved `.clinerules/workflows` to `.agents/workflows` to unify agent configuration and workflow entry points
- Task UI state restoration improvements: enhanced snapshot-first TaskUiState, ActionButtons decisions, and message-window scroll/merge behavior
- Prompt variant configuration simplified: merged Native GPT-5 variant files to reduce duplicate prompt definitions
- Provider configuration and token semantics unified: fixed profile display, model metadata, cache token accounting, and prompt cache handling

### Fixed
- Fixed multi-window task Profile isolation, context compaction boundaries, and task-level overflow state restoration
- Fixed tool approval and Resume flows, including read/list approval, rejection handling, original ask reuse after restore, and Process Anyway input forwarding
- Fixed `attempt_completion` occasionally continuing after confirmation and showing Start New Task instead of Resume after feedback restore
- Fixed auto-retry cancellation, exhausted retry prompts, and empty API conversation loops
- Fixed Apply Patch partial message timestamps, short diff marker search, MCP base URL, and related stability issues

## [0.9.0]

### Added
- Profile multi-configuration system: manage multiple API key/endpoint profiles independently
- Multi-window/multi-instance support: independent Controller instances for concurrent sessions
- `find_references` tool: find all symbol references via IDE LSP
- `rename` tool: semantic symbol rename (LSP-driven, distinguishes refs/comments/strings)
- `replace_text` tool: cross-file batch text replacement (literal or regex mode)
- `qna_respond` tool: Q&A interaction mode without modifying anything
- UsageBar real-time usage display: token consumption and cost tracking
- I18n multi-language system prompt framework: all prompts migrated to i18n keys
- GLM native tool call support
- Cline → Dline auto-migration: automatic data migration on first launch

### Changed
- Focus Chain: enforced sequential constraint execution, prevents skipping or backfilling
- Skills: enhanced slash command parsing, auto-loads associated skills into context
- Provider model configs extracted to standalone JSON files (decoupled from api.ts), user-editable
- Task state machine refactored: decoupled into MessageChannel + BlockPhaseMachine + TaskPhaseMachine
- apiKey secure storage separated from Profile configuration: dedicated key store
- Checkpoint lightweight: git diff --name-only replaces full git add ., dramatically reduces lock time
- ClineMessage incremental push: fetchMessage RPC + virtual-scroll sliding window
- Startup performance optimization

### Fixed
- Webview gray screen: blank page crash under long conversation context (root cause fix)
- Terminal Chinese garbled text: auto-detect Windows encoding (GBK/CP936 → UTF-8)
- Diff tool fixes: delimiter mismatch, orphan markers, streaming UNCLOSED false alarms
- Task resume flow stabilization: JSONL incremental storage, precise message matching
