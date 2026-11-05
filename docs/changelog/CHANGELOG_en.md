English | [中文版](https://github.com/TuvokYang/Dline/blob/dev/CHANGELOG.md)

# Changelog

## [Unreleased]

### Added
- Added the OpenCode provider: one Profile covers its paid text models on a pay-as-you-go balance or a Go, Go Plus, or Go Teams subscription, and the same model is reachable through OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages; the plan decides which models and prices apply
- Added experimental Away Mode: enable it in Settings → Features → Experimental, then send `/away` to keep the current task working while you are away, and new questions enter the mode automatically after ten minutes without an answer; workspace commands then skip approval while commands outside the workspace still need it and are refused after one minute, with existing permissions, ignore rules and hooks unchanged

### Changed
- Aggressive rendering offers three folding levels: standard rows, activity folded between messages, and activity folded across a whole user turn; bulk expand and collapse are available, live work, failures, pending approvals and checked-out checkpoints stay visible, and expanding everything restores the standard order

### Fixed
- Fixed model pricing configuration and rendering: DeepSeek shows an editable time-of-day price chart, OpenAI and Anthropic expose pricing strategies after a custom base URL is enabled, and consecutive input no longer loses values
- Improved Thinking reading: basic Markdown layout, follow the newest line while content streams, pause following when you scroll up and resume at the bottom, and no more folding, image loading or file opening from clicking the text
- Fixed TODO progress capture and restore: plan, Q&A and report progress save and refresh the header right after they are shown, indented completed items advance the next phase, and external edits are no longer overwritten by stale progress
- `attempt_completion` now ignores a mistakenly supplied `task_progress` and says so, deciding completion only from the list as it stood before the call
- Fixed the reminder cadence after a TODO list completes: reminders on the first two rounds, then at the configured interval, without repeated reports or retries advancing it again
- Local Web Fetch drops the ineffective `prompt` argument and fetches page content from the URL only; local search no longer claims to provide extra AI analysis
- Fixed the bulk toggle for activity folding: expanding all no longer collapses blocks that were already open, and no dead button appears when nothing can be expanded
- Fixed the display of consecutive reads when messages are folded: an older finished prefix stays folded while a new read is still running
- Fixed the elapsed time and TPS missing from folded headers: completed requests and usage revisions refresh the statistics, bounded retries cover temporary failures, and the last usable figure is kept
- Fixed inconsistent OpenCode thinking settings: an unset temporary value inherits the Profile, the settings page and footer share the default effort, and explicit settings are no longer overridden
- Report Bug requests a temporary diagnostics authorization before the preview appears, a failed request does not block the ordinary GitHub issue, and unchecking discards the matching authorization

## [0.12.2]

0.12.2 is the production release after 0.10.0 and contains every user-visible change from the 0.11.0, 0.11.1, and 0.11.2 pre-releases, summarized below by final behavior.

### Added
- Conversation trajectory rail: while the chat scrolls, a column of short bars appears on the right, one per user turn; hovering previews that turn's message, round count and tool calls, and clicking jumps to the message even when it is not loaded yet; the rail follows checkpoint restores and context compaction

### Changed
- Subagent cards start collapsed; click the header to expand one
- Each terminal partition keeps one idle terminal warm
- The Account rollout applies only while both usage statistics and error reporting are on, and turning either off leaves it at once
- A model is custom only by its settings: Use custom model ID with a typed ID, or Custom in the Bedrock list; usage statistics and error reports name every model by its normalized ID, custom models included
- Error reports send only the failure and runtime health events they list: a failed provider request is reported once, while expected cancellations and warnings stay on the device
- Telemetry follows contract revision 5, with usage statistics and error reports sharing one consent flow and standard OTLP channels
- Report Bug's temporary diagnostics authorization is issued by the service, and a failure never prevents opening the issue
- Usage statistics send at most every 10 minutes and error diagnostics at most every 5 minutes, following the time the service names for the next batch; after a rate limit or pause both wait as the service asks or exponentially, independently
- Rollout checks run once an hour on ordinary builds and every 5 minutes on development builds
- Error diagnostics merge duplicate events and record counts and first and last time, dropping records beyond the device and request limits and reporting how many
- Only the Account and Worktrees rollout switches remain: Web tools follow only the Web Tools switch, and OpenAI Responses WebSocket is no longer a rollout
- Usage reporting retries after 30 minutes and once at each window start instead of stopping for good
- Opening a history task shows the full-width Resume button in the footer again, and the composer's merged action button still resumes the task
- Error reporting is on by default and sends only event names, severities and short codes, never error messages, stack traces, paths or identity; it can be turned off in Settings → About
- Usage statistics describe each provider and model in more detail: failed and cancelled requests, cache and reasoning tokens, time to first output, output time, request duration, failure classes and automatic retries, without the per-request cost metric
- Error reports name providers and models the same way as usage statistics, and add the error class, HTTP status and duration of a failed request plus the build and editor family
- Dline no longer copies Cline data at startup
- Rollout checks are shared across the machine
- `${env:VAR}` in an MCP configuration resolves from the value saved for that server, then from the process environment, asking in a masked box when neither exists; each server row gains "Clear Saved Variables"
- Account is a rolled out feature and hidden by default: the onboarding sign-in choice, sidebar Account button, account page and Provider account cards appear only while the rollout is on
- The composer's send, resume, queue, and cancel actions are merged into one action button
- Images in a message are referenced in place with `<image_ref>`, and their pixels are sent after the message
- Resources attached to queued entries and sent messages are shown as chips that open the resource
- For models that accept image input, images read by `read_file` or generated by `generate_image` are returned inside the tool result
- Added `Ctrl + Alt + S` to queue the composer draft as steering input, delivered at the running turn's next tool boundary
- Added the "Load MCP Tools on Demand" setting, on by default: MCP tool definitions are no longer sent with each request, and the model picks tools from a catalog grouped by server and loads a schema with `load_mcp`
- The context window panel lists MCP tool definitions as their own item
- When a model refuses a request as longer than its context window, the oldest settled history is truncated and the request resent at once, spending no automatic retry, until it fits
- MCP call rows keep the tool name as a fixed title while the description and arguments scroll beneath it
- In-work replies and phase reports are two clearly distinct minimal rows
- Tooltips open after the pointer rests for 1 second, and still appear at once for keyboard focus
- Paths in tool rows, file cards and in-progress hints are shown relative to the workspace
- A call waiting for approval shows its full card only in the approval panel, and appears in the chat once approved or rejected
- The DeepSeek Flash model ID is renamed to `deepseek-flash` and accepts image input
- Idle tasks no longer pay periodic CPU
- Consecutive read-only rounds fold into one row that expands by round, and ends at a file change, command, approval or error
- Added usage telemetry to `otel.dline.cc`, on by default and switchable in Settings → About
- The "Dline: Reconstruct Task History" command only adds missing tasks and removes entries whose folder is gone, keeping the rest as they were
- Continuing an existing task after the upgrade keeps its conversation as it was, and a task from before the upgrade may reopen as interrupted and continue through Resume or a new message
- Per-task storage moves to separate messages, activities and metrics databases, importing earlier files on first open
- A task already open in another window is read-only here until you take it over with force unlock
- Removed the deprecated per-mode OCA/OpenRouter model settings, so continued tasks use the selected Profile's default reasoning effort
- Context compaction uses the provider's official input count or a calibrated estimate, counting images and documents separately
- Subagent costs use the effective model's billing currency, showing the currency code when it is unknown

### Removed
- PostHog product analytics and error tracking are removed, and builds no longer inject their API keys
- After the upgrade, unsent telemetry queues, an unused pairing code and earlier authorization tokens are deleted rather than migrated or sent

### Fixed
- VS Code Terminal returns stdout and exit codes reliably on WSL/Linux bash and Windows PowerShell; new tasks prewarm a terminal, cold terminals wait for Shell Integration, and sequential commands no longer create a replacement terminal for every run
- Commands waiting for a warm terminal at the same time are no longer given the same terminal, and a command in a reused terminal no longer keeps showing as running after it finished
- The kill command row follows the target command's actual state instead of always saying a termination was requested
- The browser session card is organized by round, counting calls by kind and linking each action to its page
- The browser session header reports the actual state instead of always saying Dline is using the browser, and screenshot results are never shown as base64 text
- Fixed remote MCP servers registering new OAuth clients repeatedly: windows and overlapping connections share one registered client and its tokens
- An MCP server with a connection error always offers Retry Connection, offers Authenticate beside it on 401, and names the reason for a network failure
- Fixed project MCP servers (`.agents/mcp`) having no switch, which now applies to the current workspace without changing the descriptor file
- Fixed `${env:VAR}` values being shown expanded and written back, so the configuration keeps the original references
- Fixed the MCP variable input box appearing before Dline was opened, and the approval card showing an empty server name
- Fixed remote MCP servers that require OAuth failing to authenticate, using the same flow as the Codex and Claude Code sign-ins
- Documentation links for MCP, rules, workflows, hooks, terminal and auto-approve now open docs.dline.cc, and the extension homepage is dline.cc
- A manual `/compact` shows one card per compaction, and accepting the summary waits for your input instead of sending an empty message
- Typing only `/compact` while a dialog waits compacts right away, and the dialog waits again after the summary is accepted or stopped
- Typing only `/compact` while the task works writes the summary beside the work in progress, and the next request waits for your acceptance
- The header compact button works while the task runs and only compacts, without answering a dialog or resuming a task
- Fixed the context bar dropping sharply when a compaction request is sent, the compaction failure card lingering, and two checkpoints appearing side by side after compaction or retry
- Fixed file checkpoints staying disabled after a reopen, and many checkpoints going missing
- Fixed a round's checkpoint appearing below its tool rows next to the following round, and checkpoints from several edits in one turn collecting as blank rows
- Fixed the input queue failing to open, doing nothing in a reopened task, showing the auto-approve bar through it, and delaying accepted changes
- Fixed image chip thumbnails disappearing, chips not opening on click, a duplicate thumbnail under a sent message, and `read_file` returning no image to the model
- Fixed pasted images sharing a name, resource record files being attached as input, and a format badge wrapping onto two lines
- Fixed pasting an image in a read-only history task and pressing Resume failing to send it
- Fixed a long conversation shaking at the bottom, a task reopened after an abnormal exit not staying at the bottom, and a panel returning to an older position when shown again
- Fixed the first message in a task opened from History clearing the chat, and tasks with more than 500 messages failing when a deferred hosted call was resumed
- Fixed tool groups jumping while later rounds run, by closing each group at its request round
- Fixed a tool call that needs approval showing two cards, so one call stays one row from preview to result
- Fixed Thinking from the same turn appearing after a turn-ending card, duplicate cards after a retry, and the follow-up question card rendering inside the reply
- Fixed API error cards carrying their own Retry Request button, the Retry prompt showing only the raw error, and a rejected key still offering Retry
- Fixed a failed API request leaving only Retry / Start New Task with no error card
- Fixed long `attempt_completion`, `qna_respond` and `generate_report` output appearing only at the end, duplicating, or disappearing after reopen
- Fixed long cards such as `attempt_completion` losing their internal scrolling to the chat
- Fixed commands staying Running with no Cancel button in the Activities panel
- Fixed the task header's cumulative cost being lower than in the task history list
- Fixed a setting changed in one window not reaching another open window
- Fixed task history losing tasks when the Documents folder has been moved
- Fixed the `rename` tool failing when the target file was not open in an editor
- Fixed only some mid-stream disconnects being retried, and upstream HTTP/2 stream errors failing ordinary tasks and subagents outright
- Fixed a transient failure while preparing a request surfacing at once as `API Request Failed`
- Fixed a completed, already billed reply being discarded when the model produced only hidden reasoning
- Fixed encrypted or redacted reasoning leaking into visible text
- Fixed a `.agentignore` in a nested directory being ignored
- Fixed the slash command and @ mention menus closing when focus moves to another window
- Fixed LaTeX formula blocks using several commands failing to typeset
- Fixed native MCP function names carrying a per-process random server identifier
- Fixed new files being saved with CRLF when Background Edit is on
- Amounts in yuan show ¥ everywhere, and an unlisted currency shows its code
- Fixed Stable and Insiders showing two action sets or one extension failing on duplicate IDs when both are installed
- Fixed one window holding remote usage telemetry so other builds could not report
- Fixed a subagent reporting five empty responses instead of the provider's actual error
- Close Task cancels the commands and subagents still running in the task
- Fixed messages sent after a task completed but before the reply box was ready being refused

### Release
- Each Insiders run keeps only the latest draft and shows the current cumulative dev changes; pre-release and production notes come from the matching changelog version section and fail when it is missing or empty

## [0.11.2]

### Added
- Conversation trajectory rail: short bars on the right preview each user turn and jump to the message, and the rail follows checkpoint restores and compaction

### Changed
- Subagent cards start collapsed
- The Account rollout applies only while both usage statistics and error reporting are on

### Removed
- PostHog product analytics and error tracking are removed
- After the upgrade, unsent telemetry queues and earlier authorization tokens are deleted

### Fixed
- VS Code Terminal returns stdout and exit codes reliably on WSL/Linux bash and Windows PowerShell, and new tasks prewarm a terminal

## [0.11.1]

### Changed
- Usage statistics use a structured request body, aggregated by purpose, model and provider with the remainder merged, covering up to 60 active minutes per batch
- Usage statistics and error diagnostics send on their own schedules, following the time the service names for the next batch and waiting as the service asks or exponentially, independently
- Rollout checks run once an hour on ordinary builds and every 5 minutes on development builds
- Error diagnostics merge duplicate events, record counts and first and last time, and report how many records were dropped

## [0.11.0]

### Changed
- The Account rollout reaches only devices that report usage statistics, only Account and Worktrees remain as rollout switches, and Web tools follow only the Web Tools switch
- Error reporting is on by default and sends only event names, severities and short codes, while usage statistics add failed and cancelled requests, cache and reasoning tokens, time to first output, request duration, failure classes and retries
- Error reports name providers and models the same way as usage statistics and add the error class, HTTP status and duration of a failed request
- Usage reporting retries after 30 minutes or at the next window start, and rollout checks are shared across the machine
- Dline no longer copies Cline data at startup
- `${env:VAR}` in an MCP configuration resolves from the value saved for that server, asking in a masked box when neither exists, and each server row gains "Clear Saved Variables"
- Account is a rolled out feature and hidden by default
- The composer's send, resume, queue, and cancel actions are merged into one action button
- Images in a message are referenced in place with `<image_ref>`, and attached resources are shown as chips
- For models that accept image input, images read by `read_file` or generated by `generate_image` are returned inside the tool result
- Added `Ctrl + Alt + S` to queue the composer draft as steering input
- Added the "Load MCP Tools on Demand" setting, on by default, which stops sending full MCP tool definitions with each request
- The context window panel lists MCP tool definitions as their own item
- A request longer than the context window truncates the oldest settled history at once, spending no automatic retry
- MCP call rows keep the tool name as a fixed title while the description and arguments scroll
- In-work replies and phase reports are two clearly distinct minimal rows
- Tooltips open after the pointer rests for 1 second
- Paths in tool rows and file cards are shown relative to the workspace
- A call waiting for approval shows its full card only in the approval panel
- The DeepSeek Flash model ID is renamed to `deepseek-flash` and accepts image input
- Idle tasks no longer pay periodic CPU
- Consecutive read-only rounds fold into one row
- Added usage telemetry to `otel.dline.cc`, on by default
- The "Dline: Reconstruct Task History" command only adds missing tasks
- A task from before the upgrade may reopen as interrupted and continue through Resume
- Per-task storage moves to separate messages, activities and metrics databases
- A task already open in another window is read-only here
- Removed the deprecated per-mode OCA/OpenRouter model settings
- Context compaction uses the provider's official input count or a calibrated estimate
- Subagent costs use the effective model's billing currency

### Fixes
- Fixed a round's checkpoint sometimes appearing below the round's tool rows, right next to the following round's checkpoint

### Release
- Each Insiders run keeps only the latest draft; pre-release and production notes come from the matching changelog version section and fail when it is missing or empty

## [0.10.0]

0.10.0 is the production version number for the 0.9.4 content, because the registry already held a 0.9.4 pre-release; everything below under 0.9.4 is included in this release.

### Fixes
- TPM counts only the output tokens returned by the API; prompt and cache tokens no longer inflate the rate
- A TODO list is no longer treated as modified after its formatting is normalized
- The composer scrollbar track and maximum height are fixed, so a long input keeps its scrollbar visible within the available height

### Release
- Version rules: production releases use an even minor, pre-releases an odd minor, and Insiders follows the pre-release; packaging rejects a release tag with the wrong parity
- Registry publication currently targets Open VSX only, and a version already held by the other track fails instead of reporting a false success

## [0.9.4]

### Features
- Parallel tool calls: calls in one turn that need no manual approval can run concurrently, calls needing approval are confirmed one at a time, and the maximum is configurable
- `use_subagents` accepts up to 32 subagents per call with their own agent, Profile and timeout, and queues the rest beyond the parallelism limit
- Claude Code Profiles sign in with OAuth and reach the Anthropic Messages API directly, optionally sending a Claude Code billing attribution header
- Anthropic and Claude Code declare hosted Web Search and Web Fetch when supported, and a forced remote mode never silently falls back to local
- The built-in catalog adds Claude Opus 5.5 as the default for Anthropic and Claude Code
- New bilingual documentation and branding: English at the site root, Simplified Chinese under `/zh-cn/`, with the new icon and mascot
- Any file pasted or dropped into the composer is attached as text besides images, PDFs, Word and Excel, and binary content is refused

### Changed
- Subscription usage identifies quota windows and snapshot age and counts Dline's own daily input and output tokens locally
- History tasks load through a lightweight read-only window that keeps their Profile, lock notice and subagent metrics
- Command logs and shell diagnostics live in the task's temporary directory and are cleaned under a per-task size budget
- Migration from Cline no longer imports history that Dline cannot open or restore
- When you switch models, earlier readable reasoning becomes ordinary context, and encrypted reasoning and response IDs are no longer sent to the new model
- `dev-vX.Y.Z` pre-releases publish through the production extension's Marketplace pre-release track, while Insiders stays a separate extension
- System prompt changes strengthen proactive Skill and Workflow invocation
- `spawn_task` always needs manual approval, while YOLO and approve-all still allow it
- Reading, searching and writing inside the current task's temporary directory no longer asks for approval
- Web Fetch, Web Search and code execution cards expand and collapse from their headers

### Fixed
- Fixed request-level approval appearing merely because hosted Web capabilities were declared
- Fixed `generate_image` losing its title, prompt or image card on approval, rejection or reopen
- Fixed reasoning from another protocol being replayed as Anthropic thinking after a provider switch
- Fixed a task close failure showing no notice and a reopened task showing a stale reply draft
- Fixed duplicate approval and input submissions, stacked failure cards from automatic retries, and cards folding early while a command streams
- Fixed listeners and log streams not closing after a command ends, fails to start or is cancelled
- Improved `replace_in_file` diagnostics, naming the delimiter, SKIP, line labels and the first difference
- Fixed a Profile switch leaving stale provider replay state or inconsistent queued input
- Fixed history restore briefly returning to the home screen or leaving an unusable Resume view
- Improved the first paint of an opened or restored history task, showing the message window before secondary hydration
- Fixed the task view remaining after the current task was deleted and confirmed
- A Webview render failure now shows a recoverable error surface instead of only a blank screen
- Fixed hosted tools returning `pause_turn` or arriving after client tool calls failing to continue
- Fixed one failing Git tracker losing every checkpoint in a multi-root workspace
- Fixed Marketplace README links and images following the default branch
- Fixed hosted Web Search and Web Fetch calls and results not reaching later context
- Fixed an attached PDF being truncated into text instead of sent as a native document
- Fixed dropped or pasted PDFs and similar files not being attachable from the composer
- Fixed long composer text being truncated with no scrollbar
- Fixed images and PDFs in feedback entering the context as base64 text
- Fixed slash commands typed in a completion or follow-up reply being sent as plain text
- Fixed the `new_task` handoff skipping the approval or feedback card
- Fixed a manual compaction failing when resuming a task or when no summary was available
- Improved compaction reliability, retrying correctable failures and showing the reason on the card
- Fixed a tool result from just before auto-compaction being resent as an orphan or lost from history
- Fixed the newest reply not appearing while messages grow quickly, and the reading position jumping in a long history
- Fixed an interrupted command still showing Running with Cancel after reopening a history task
- Fixed switching Plan/Act mode while a completion confirmation waited, which lost the typed draft
- Fixed terminal prewarm moving keyboard focus into the editor and typing into an open file

## [0.9.3]

### Features
- Expanded OpenAI Codex support: dynamic model discovery, Responses over HTTP and WebSocket, hosted Web Search, reasoning and Service Tier controls, plus shared account quota and rate-limit actions
- OpenAI and Codex image sources can be subscription, API, independent or hosted, with one default model and automatic migration of earlier settings

### Changed
- Usage reporting and error diagnostics now use independent consent channels, and the legacy single consent is not migrated automatically
- Diagnostics stay on the local machine by default, and anything sent has prompts, file content and credentials filtered out first
- The provider picker is generated and grouped by ModelRegistry
- Experimental features resolve from local configuration instead of sign-in or remote PostHog

### Fixed
- Fixed stale account usage after Profile switches, refreshes that did not update or provide feedback, and incorrect quota summary selection
- Fixed overlapping usage popovers, overflowing reset cards, and Context Window panels overlapping
- Fixed a subagent that reached its timeout or context pressure limit failing to settle, with its result truncated or lost
- Fixed context compaction retry recovery after an extension reload
- Fixed virtual scrolling jitter in long conversations during first positioning, streaming, upward browsing and resizing
- Fixed the Recent route and completion actions after closing a task
- Fixed MCP Marketplace refreshing repeatedly, losing search focus and unmounting on error
- Fixed the task rate chart's Total Tokens calculation, and gave TPM and RPM their own axes
- Fixed image generation failures or cancellations reading an already deleted temporary preview
- Foreground command output beyond the display limit now links to the complete log file in the chat and Activities
- Fixed overlapping or clipped tool paths, file names, line numbers and match counts in narrow windows
- Command prompts now match the shell the environment reports
- Fixed the error card still naming `.clineignore` when an ignore rule blocked access

## [0.9.2]

### Features
- Activities panel: Work / Activities tabs showing task execution, subagent metrics, tool timelines and retry progress
- Runtime diagnostics: optional local telemetry sampling and a one-click diagnostics bundle
- Image generation with `generate_image`, supporting OpenAI independent and hosted image sources
- OpenAI Codex Profile OAuth: a browser sign-in per Profile, with remaining quota shown in the usage bar
- Capability loaders: `load_skill`, `load_workflow` and `load_mcp` load skills, workflows and MCP tool metadata on demand
- `kill_command` terminates a running command
- Input queue: keep typing while a task runs, and messages queue and arrive at a safe boundary
- Terminal pool: warm terminals are ready so commands no longer wait for a cold start
- Command controls: a `workdirectory` argument, command timeouts and background handoff settings
- `.agentignore` permissions: separate grants for read, write, execute and list
- Capability scope chain: overrides at the global, workspace and task level
- Web tool mode per Profile: automatic, forced local, forced remote or off
- API Format selector when a model supports several protocols
- OpenAI Service Tier selection and task-level runtime control
- Task rate metrics and charts, prompt cache health, and mode and Profile switch dialogs
- LaTeX rendering and Mermaid export, structured API errors, and a configurable send shortcut

### Changed
- Subagent enhancements: background execution, timeout control, retrying recoverable failures, output budgets and batch request parsing
- `plan_mode_respond` is renamed to `make_plan` and `focus_chain_change` to `change_todo_list`
- Task history moves to SQLite storage and imports earlier data automatically
- Prompt architecture is modularized, with variants reduced to the standard and lite profiles
- Context compaction gains a pass budget and a retry replay policy
- Model discovery is unified in ModelRegistry, and the model picker becomes one searchable field
- Settings are no longer projected into VS Code global state
- Ignore rule handling is unified and workspace traversal is CPU-bounded
- Anthropic supports the long-context beta with automatic reasoning effort fallback

### Fixed
- Fixed task state and lifecycle defects across cancellation, resume, checkpoints and concurrent panels
- Fixed context compaction accounting, backpressure, retry replay and interrupted recovery
- Fixed Profile switch, admission and credential isolation across concurrent tasks
- Fixed tool result ordering, skipped results after a rejected approval, and native tool round restoration
- Fixed terminal output ordering, background handoff, stalled command recovery and Chinese encoding
- Fixed Webview virtual scrolling, streaming diff scrolling, button routing and mismatched interaction state
- Fixed MCP reconnect loops, descriptor watching and workspace descriptor loading

## [0.9.1]

### Features
- Task-level Profile model switching isolates API configuration per task and prevents cross-window contamination
- OpenAI Native and OpenAI Codex model data is updated with thinking and reasoning settings

### Changed
- The agent workflow directory moves to `.agents/workflows`
- Task UI state restoration is strengthened, with smoother message window scrolling and merging
- Prompt variants are simplified, removing duplicate files
- Provider configuration and token semantics are unified further

### Fixed
- Fixed multi-window task Profile isolation, context compaction boundaries and overflow state restoration
- Fixed approval and resume flows, including read and list approvals, rejected approvals and input forwarding
- Fixed a task occasionally failing to stop and the state flow that showed Start New Task incorrectly
- Fixed automatic retry cancellation, a missing Retry after retries ran out, and empty-response loops
- Fixed Apply Patch timestamp handling, short diff marker search and MCP base URL stability

## [0.9.0]

### Added
- Profile multi-configuration: manage several API key and endpoint profiles
- Multi-window and multi-instance support for unrelated conversations at the same time
- `find_references`, `rename`, `replace_text` and `qna_respond` tools
- UsageBar shows token consumption and cost live
- Prompt internationalization: every system prompt moves to i18n
- GLM native tool calling
- Automatic Cline to Dline migration on first start

### Changed
- Focus Chain enforces sequential execution and prevents skipping or backfilling
- Skills load the matching skill when a slash command is parsed
- Provider model configuration moves to an editable JSON file
- Task state machines are decoupled into a message channel and phase machines
- API keys move to dedicated secure storage, separate from Profile configuration
- Checkpoints are lighter, cutting the time the lock is held
- Incremental message delivery with a virtual scroll window, and faster startup

### Fixed
- Fixed the Webview gray screen where long conversations crashed to a blank page
- Fixed Chinese text corruption in Windows terminals by detecting the terminal encoding
- Fixed Diff tool false positives around delimiters, orphan markers and streaming
- Task restore is now stable
