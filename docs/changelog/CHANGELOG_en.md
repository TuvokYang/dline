English | [中文版](https://github.com/TuvokYang/Dline/blob/dev/CHANGELOG.md)

# Changelog

## [Unreleased]

## [0.12.2]

0.12.2 is the production release after 0.10.0. It includes every user-visible change from the 0.11.0, 0.11.1, and 0.11.2 pre-releases, summarized below by their final behavior.

### Added
- Conversation trajectory rail: while the chat scrolls, a column of short separate bars appears on the right, one per user turn, white on dark themes and gray on light themes, with attempts set apart by their background. Hovering a bar previews that turn's user message, round count and tool calls; clicking it jumps to the user message, even when it is outside the loaded range. The trajectory is kept separately in the task's `trajectory.db`, linked back to the chat by message ts, and updated incrementally as messages arrive, without reading or rewriting the whole chat; it follows checkpoint restores and context compaction

### Changed
- Subagent cards start collapsed; click the header to expand one
- Each terminal partition keeps one idle terminal warm
- After a rate limit or telemetry pause (HTTP 429), the refused telemetry batch is kept unchanged and sent first once the wait ends, with the same request ID and content, instead of rejoining the pending data under a new request ID; data gathered during the wait forms its own batch, and neither the 429 nor its wait counts toward the 12-attempt and 24-hour retry limits
- The Account rollout is fetched only while both usage statistics and error reporting are on; turning either off, including in another window, leaves the rollout at once and deletes the rollout answers stored on the device instead of keeping them
- A model is custom only by its settings: Use custom model ID checked with the ID typed in, or Custom selected in the Bedrock model list; a model picked from the list is no longer custom, even on Ollama, LM Studio, or LiteLLM, behind a custom base URL, or outside the built-in catalog. Usage statistics and error reports name every model by its normalized model ID, custom models included, instead of replacing a custom model with `_custom`, so a typed ID is sent too (for example the region and AWS account ID in a Bedrock inference profile ARN); a custom model is additionally marked `custom: true` in usage statistics and has `model.custom` set to `true` in error reports
- Error reports send only the failure and runtime health events they list: a failed provider request is reported once, as `api.request.failed`, instead of also as `task.provider_api_error`; `task.error`, expected cancellations (such as a stopped request or a withdrawn review), and messages logged as warnings stay on the device, a failure logged only as a warning is no longer reported as an error, and only one sampler per extension host reports a performance budget breach. Records gain `error.site` (where the failure was caught), `error.fingerprint_version` (fingerprint version 3 groups by that place), `tool.name` for built-in tools, `failure.stage`, and `perf.*` for a performance budget breach; a development build marks its requests with `dline.is_dev=true`. The local loopback OTLP sink also accepts the error channel, and the `dline.errors.*` metrics are no longer recorded
- Telemetry to `otel.dline.cc` follows contract revision 5, and every request carries `X-Dline-Contract: 5`: device authorization uses `/auth/device/grant`, and usage statistics go to `/usage` as schema 5; error reports and runtime diagnostics go to `/v1/logs` as standard OTLP/JSON, joined by new production `/v1/metrics` (one delta window every 60 seconds) and `/v1/traces` channels. Dline's own paths carry no `/v1`, and feature flag requests likewise use `/features`
- Report Bug's temporary diagnostics authorization is issued by the service (`/auth/report-authorizations` and `/auth/exchange`); a failed authorization or telemetry request never prevents opening the issue
- Usage statistics send a batch at most every 10 minutes and error diagnostics at most every 5 minutes by default, and both follow the time the service names for the next batch; after a rate limit or telemetry pause (HTTP 429), that channel sends nothing until the wait ends, which is the time the service asks for or else one minute doubling up to 30 minutes, plus up to 10% random spread and never more than 7 days, and which survives a restart; the two channels wait independently
- Rollout checks are less frequent: an ordinary build asks once an hour (previously every 30 minutes), and a development build every 5 minutes (previously every minute)
- Error diagnostics merge events with the same name, severity, error fingerprint, error class, provider, and model before sending, recording the number of occurrences and the first and last time; only attributes from the service's catalog are sent; one device keeps at most 50 new records per hour and 200 per day, and a request holds at most 100 records within 128 KiB, so records beyond these limits are dropped locally and their count is reported in the next request; a request that is too large is split in half and sent again
- Only two rollout switches remain, Account (`account`) and Worktrees (`worktree-exp`): Web tools follow only the Web Tools switch in Settings → Features and no longer depend on a rollout, and OpenAI Responses WebSocket is no longer a rollout
- Usage reporting no longer stops for good after the service or its network edge refuses it: it tries again after 30 minutes and once whenever a VS Code window starts; a service that still refuses is left alone for another 30 minutes instead of being asked on every cycle
- Opening a history task shows the full-width Resume button in the footer again, so it is easy to notice; the composer's merged action button still resumes the task, and Cancel stays only in the composer button
- Error reporting is now on by default, and while it is on, failure events such as provider API errors and terminal hangs are sent to `otel.dline.cc` as OTLP logs: only the event name, severity, and short codes, never error messages, stack traces, paths, or Task, workspace, or account identity; error diagnostics and usage reporting each use their own token and queue, so turning one off deletes only its token and unsent data and leaves the other running; it can be turned off in Settings → About
- Usage statistics now describe each provider and model in more detail: failed and cancelled requests, cache and reasoning tokens, time to first output, output time, and request duration with histograms, failures by class (such as rate limited, overloaded, timeout, or network), and automatic retries with their waiting time; each extension start is counted once; the per-request cost metric is no longer sent
- Error reports name the provider and model the same way as usage statistics, so a model ID containing `/` is no longer dropped; they also carry the error class, HTTP status, and duration of a failed provider request, and the report states whether it comes from the stable or Insiders build and which editor family (VS Code, Cursor, VSCodium, Windsurf, or other) runs Dline
- Dline no longer copies Cline data at startup (`~/.cline`, `Documents/Cline`, and the legacy Cline extension storage)
- Rollout checks are shared across the machine
- `${env:VAR}` in an MCP configuration is resolved at connect time from the value saved for that server, then from the VS Code process environment; when neither exists, a masked input box asks for it, and the value is saved for that server only, in its own scope (global for a server from the global settings, the current workspace for a workspace descriptor server), never shared with other servers; cancelling or leaving it empty keeps the server disconnected with an error, and restarting the server asks again; each server row in the MCP settings gains "Clear Saved Variables", which forgets the server's saved values and reconnects it
- Account is now a gradually rolled out feature and hidden by default: the account sign-in choice in onboarding, the sidebar Account button, the account page, and the account cards and sign-in prompts in Provider settings appear only while the Account rollout is on
- The composer's send, resume, queue, and cancel actions are merged into one action button
- Images in a message are referenced in place with `<image_ref>`, and their pixels are sent to the model after the message
- Resources attached to queued entries and sent messages are shown as chips that open the resource
- For models that accept image input, images read by `read_file` and generated by `generate_image` are returned inside the tool result, tagged with their file name or Artifact ID
- Added `Ctrl + Alt + S`, which queues the composer draft directly as steering input, delivered at the running turn's next tool boundary; the `Shift + Q + Enter` / `Shift + S + Enter` chords and sending or queuing as plain text are removed, and the send key still queues while a task runs
- Added the "Load MCP Tools on Demand" setting, on by default: instead of sending every MCP tool's full definition as a native tool with each request, the model picks tools from the prompt's MCP catalog, grouped by server with only names and bounded descriptions, loads a tool's input schema with `load_mcp`, and calls it with `use_mcp_tool`; turning it off restores native MCP tools
- The context window panel lists MCP tool definitions as their own item instead of folding them into tool definitions
- When a model refuses a request as longer than its context window, including after its stream has started, the oldest settled history is truncated and the request resent at once, whether or not auto-compaction is on; this spends no automatic retry and shows no countdown, and repeats until the request fits; an error appears only when nothing more can be removed, that is when a single item is larger than the whole window
- An MCP call row stays open while the call runs; once its result arrives, the request and the response fold together into the header, which shows the tool name and reopens the row when clicked; when open, the tool name is a fixed title and only the tool description and arguments scroll beneath it; clicking the tool name folds the description and arguments on their own; the description and the arguments each have a subheading and the same framed box, arguments are listed by name, and string values are shown without JSON escape backslashes; and the card's scrollbars are thin and follow the theme (dark in a dark theme)
- In-work replies (Reply) and phase reports (Phase report) are now two clearly distinct minimal rows
- Tooltips now open only after the pointer rests on a button or label for 1 second, so moving across the interface no longer flashes them; a tooltip opened by keyboard focus still appears at once
- Paths in tool rows, file cards and in-progress hints are shown relative to the workspace; with several workspace folders open they are prefixed with the folder name (such as `backend/src/a.ts`); only a path outside the workspace stays absolute, and a relative path no longer gains a leading `/`; clicking still opens the reported path
- A call waiting for approval (read-only tools, terminal commands, edits, MCP, the browser, subagents and new tasks) now shows its full card only in the approval panel at the bottom, above Approve and Reject, instead of also in the chat; once approved or rejected the call appears in the chat, and a read-only call joins its round's tool group directly instead of first showing a separate "Dline wants to…" card
- The DeepSeek Flash model ID is renamed from `deepseek-v4-flash` to `deepseek-flash` (the default model follows) and accepts image input; remotely discovered DeepSeek models default to native tool calling and reasoning effort, and a capability the model listing states explicitly takes precedence
- Idle tasks no longer pay periodic CPU: storage skips the locked flush when nothing is staged, and task history writes no longer reconfigure components
- Consecutive read-only rounds (thinking plus reads, folder listings, searches, and definition or reference lookups, with no file change in between) fold into one row: collapsed, it reads like an ordinary tool group, with the checkpoint taken before the exploration, a summary of reads, searches, thoughts, and rounds, and every round's file and operation rows (click to open the file or show search results), folding away only the thinking and the checkpoints in between; clicking the summary lists each round with its checkpoint, thinking you can click to read, and tool calls; a file change, command, approval, error, or user input ends the row, and every checkpoint stays restorable
- Added telemetry to Dline's service at `otel.dline.cc`: usage telemetry is on by default and can be turned off in Settings → About; it counts provider and model usage for rankings
- The "Dline: Reconstruct Task History" command no longer replaces the whole task history: entries whose task folder still exists keep their workspace, favorite, and completion state, only missing tasks are added, and entries whose folder is gone are removed; an added task recovers its workspace from its first request, so the Workspace Only filter shows it again
- The task runtime now stores conversations in a journal; the first time an existing task is continued after upgrading, its conversation is imported unchanged and later requests carry the full history; per-task `state.json` replaces `snapshot.json`, and the migration imports only the queued inputs, not the earlier completion state
- Tasks from before the upgrade may reopen as interrupted, including tasks that were running or already completed, and continue through Resume or a new message; a task opened after upgrading cannot be continued by downgrading to an older Dline build
- Per-task storage moves to `messages.db`, `activities.db`, and `metrics.db`: an existing `ui_messages.jsonl` or `activities.json` is imported on first open and renamed to `*.migrated`, an existing `<task-id>.db` becomes `metrics.db`, and `api_conversation_history.jsonl` is left unchanged
- A task already open in another window is read-only in this window: input and footer actions are disabled, and replies, queue changes, compaction, activity controls, mode and Profile switches, and checkpoint restore are refused until you take the task over with force unlock in the lock banner
- Removed the deprecated per-mode OCA/OpenRouter model ID, model info and reasoning effort settings (cleaned once at startup), so continued tasks use the selected Profile's default reasoning effort; also removed the legacy `updateApiConfigurationProto` RPC and unused Groq/Hugging Face/Baseten model list state in the Webview
- Context compaction now uses the provider's official input count when available, or calibrates text estimates from real usage for the same provider, model, and API format; images and documents are counted separately, accepted passes are persisted, and multi-pass compaction resumes from the last safe checkpoint
- Subagent costs now use the effective model's billing currency, with unambiguous labels for Chinese yuan and Japanese yen and the currency code retained for unknown currencies

### Removed
- PostHog product analytics and error tracking are removed from both the extension and the Webview, and builds no longer inject their API keys; the earlier `/auth/device/exchange` authorization is removed too
- After the upgrade, usage statistics and error report queues that an earlier version left unsent on the device, the pairing code that was never used, and earlier authorization tokens are deleted rather than migrated or sent; the device keeps only metadata recording what was discarded and how much, without its content

### Fixed
- VS Code Terminal records an internal exit marker for every foreground command on WSL/Linux bash and Windows PowerShell, so stdout and exit codes remain reliable even without a project terminal configuration; new tasks prewarm immediately, slow cold terminals wait until Shell Integration is executable, and sequential commands with aggressive terminal reuse no longer create and discard a replacement terminal for every run
- With no workspace open on Linux, server/remote extension hosts such as Remote-WSL, SSH, and dev containers now default to the user's home directory (`~`), while local Linux desktop hosts continue to default to `~/Desktop`
- When an endpoint has no token-counting route (HTTP 404 or 405), Dline no longer requests a count again before every context estimate and uses its estimate instead
- Stable and Insiders now use independent sidebar, title action, command, task panel, diff, and code-review registrations when both are installed, so one Dline view no longer shows two action sets and neither extension fails on duplicate IDs; Insiders keeps Enter-to-submit in code-review replies but no longer declares extension shortcuts that compete with Stable defaults
- When several Dline builds or windows run at once, remote usage telemetry now takes turns sending instead of one window holding the sender indefinitely and leaving other builds unable to report; telemetry file names are unchanged
- Compacting context from the task header after a task completed no longer brings back Start New Task or other buttons after Condense; typing continues the task
- Pasting an image and typing text in a history task that is only displayed, then pressing Resume, now sends both; when an attachment is no longer available and the message is refused, the composer explains why instead of silently putting the draft back
- Fixed remote MCP servers registering new OAuth clients again and again: windows and overlapping connections now share and reuse one registered client and its tokens instead of overwriting or deleting each other's
- Commands waiting for a warm terminal at the same time are no longer given the same terminal
- The browser session card is organized by round: each round's checkpoint and thinking fold into the card instead of piling up as empty checkpoints below the screenshot. The checkpoint taken before the launch stays at the top of the card, and a checkpoint whose files changed during the session or that is checked out stays visible. Below the frame, a summary counts the calls by kind the way file reads are counted (for example 1 launch, 2 clicks · 4 rounds) and expands to list each round's checkpoint, thinking and actions; clicking an action shows its page. The whole card folds from its header down to the header and the page URL
- The browser session header reports the actual state (using, used, waiting for approval, not approved, interrupted or failed) instead of always saying "Dline is using the browser"
- Browser screenshot results are never shown as base64 text in the chat, including when the loaded message window starts mid-session or browsing continues after a cancelled request
- The kill command row follows the targeted command to its actual state (terminating, terminated, already finished, interrupted, or no running command matched) instead of always saying "Dline requested command termination"
- An MCP server with a connection error always offers Retry Connection; when the server answers 401 and asks for authentication, Authenticate is shown beside it instead of replacing it. The authentication message says the server answered 401, and a network failure names its reason (such as ECONNREFUSED and the address) instead of only "fetch failed"
- A manual `/compact` shows one card per compaction: its progress, the summary review (Condense Conversation / Regenerate Summary) and the landed result are all drawn on the same card, a regenerated summary returns to that card, and the finished card reads "Dline condensed the conversation". Sending only `/compact` (optionally with what to keep) waits for your input once you accept the summary instead of starting a request with an empty message; after a stopped compaction the composer accepts a reply directly instead of needing the task to be reopened and resumed
- Typing only `/compact` (or using the header compact button) while a completion, follow-up question, plan or similar dialog waits compacts right away; the summary review takes that dialog's place until it is accepted or stopped, and the dialog then waits again instead of receiving an empty answer; doing so while a tool waits for approval no longer rejects the tool
- The attempt_completion dialog opens as soon as the result is shown, so queued messages are sent at once; the checkpoint, change comparison and TaskComplete hook run while the dialog is open, and the next round still starts only after they finish
- Typing only `/compact` (optionally with what to keep) while the task works writes the summary right away beside the work in progress; its review opens once the round ends or before the next one starts, and the next request waits until you accept it. It no longer enters the input queue, so it is never taken as a dialog's answer at the end of a turn or sent as an empty message in a tool round
- The header compact button also works while the task runs, through the same immediate compaction; in every state it only compacts, without answering a waiting dialog or resuming an interrupted task. The context bar's token counts, progress bar and compact button are vertically centered
- Choosing Retry after a manual compaction ran out of retries continues the task once the compaction lands, instead of stopping on a state read from before the compaction was requested
- When the wrap-up request a subagent makes after a timeout or a finish request fails, the subagent reports the provider's actual error instead of five empty responses
- The page the browser opens after authorizing an MCP server or another remote service shows the Dline mark instead of the old Cline icon
- Compacting the context, a reply without tools, or Retry after a failed request no longer leaves two checkpoints next to each other: when nothing visible sits between them, an unchanged workspace reuses the previous checkpoint and a changed one replaces it with the new checkpoint
- API error cards such as an exhausted balance no longer carry their own Retry Request button; Retry, Start New Task, and replies come only from the task footer, and the card keeps only links such as top-up or sign-in
- Opening a long task saved by an earlier version from History and immediately pressing Resume or sending a message no longer leaves the chat stuck mid-history; the message just sent and the replies after it are shown
- Amounts in yuan show ¥ everywhere: subagent metrics, the activity panel and tiered model pricing no longer show CN¥, and balances no longer use the full-width ￥; every amount takes its symbol from the currency in the model's pricing, and an unlisted currency shows its code instead of $
- With Background Edit on, new files and files that used CRLF are saved with LF line endings; on Windows a new file previously took CRLF from VS Code's default end of line
- Fixed a round's checkpoint sometimes appearing below the round's tool rows, right next to the following round's checkpoint: the checkpoint row now takes its place when the round starts, shows no Compare or Restore while the file snapshot is being committed, and is completed in place afterwards; when no file changed, the round reuses the previous snapshot instead of committing again
- Fixed the `rename` tool always failing with `Unexpected type` when the target file was not open in an editor: VS Code passed the new name as an array when renaming in a document it had not loaded, so Dline now loads the document first and cross-file renames work on files that are not open
- Fixed a setting changed in one VS Code window sometimes not reaching another open window: a window that saved an unrelated setting before it noticed the change took the new value without showing it, and a hand edit of `settings.json` that kept its stored revision was ignored; every window now shows the latest settings document
- Fixed workspace MCP servers (`.agents/mcp/` descriptors) showing no Auto-approve checkboxes
- Fixed task history losing tasks when the Documents folder has been moved
- Fixed a failed API request leaving only Retry / Start New Task in the chat with no error card
- Fixed the approval card for MCP tool calls and resource reads showing an empty server name and describing a tool call as accessing a resource; the card now shows the MCP server, the tool and its arguments
- Fixed the values of `${env:VAR}` references in the MCP settings being shown expanded on the settings page and written back to `mcp_settings.json` when a setting such as the timeout changed: the configuration now keeps the original references and resolves them only when connecting
- Fixed project MCP servers (`.agents/mcp`) having no switch in the settings list: like other servers, the switch applies to the current workspace and is kept in Dline's local workspace state, and the descriptor file in the repository is not changed; a single task can still switch a server off from the task's MCP switches
- Fixed remote MCP servers that require OAuth failing to authenticate: servers rejected the `vscode://` callback when registering the client (`redirect_uris must only contain web uris`), the VS Code window that received the callback after a successful authorization could not find the authorization state (`No stored state found`), and after one failure every further **Authenticate** click failed as well. MCP now uses the same OAuth flow as the OpenAI Codex and Claude Code sign-ins: every click creates a fresh PKCE pair and state, and after you authorize, the browser returns directly to a local page on `127.0.0.1` served by the window that started the authorization, with no prompt to open VS Code; clients registered earlier register again automatically; an authentication failure now shows its reason; Dline registers with servers as the client "Dline" instead of "Cline"
- Fixed the MCP variable input box appearing before Dline was opened
- Documentation links for MCP, rules, workflows, hooks, terminal, auto-approve and worktrees now open the matching pages on docs.dline.cc, the About telemetry and privacy links open the telemetry and privacy documentation on docs.dline.cc, and the account page's terms of service and privacy policy now point to dline.cc; the extension homepage is now dline.cc
- Scroll areas such as What's New, an expanded exploration run and tool results no longer show a white scrollbar in dark themes: every scroll area in the Webview now uses the thin theme-colored scrollbar of the MCP card by default
- A rejected API key (such as a 401 `invalid_api_key`) no longer offers Retry
- Fixed file checkpoints staying disabled for good after a task was reopened: a message an earlier session saved, such as "Checkpoints initialization timed out", no longer stops the new session from initializing, so checkpoint rows carry a restorable file hash again; rounds that arrive while initialization is still slow now wait for it instead of writing rows without a file snapshot
- Fixed messages sent after a task completed but before the reply box was ready being refused with "Dline cannot take input yet"; input in that window is now queued and delivered as the reply
- Fixed a phase report and the tool rows of the same turn swapping order when the report completes
- Fixed the input queue (Queue) failing to open in the sidebar and showing only a thin scrollbar
- Image chips no longer show the file name; only the thumbnail and the format badge remain
- Fixed image chip thumbnails disappearing once the image is queued or sent, or after it is cut and pasted in the input box
- Fixed the context bar dropping sharply when a compaction request is sent, for example from 560k to about 410k: the sending round replaced the provider's measured count of the conversation with a local estimate of the same conversation; the measured count now stays while the pass is sent and drops only once a pass is accepted and the conversation is actually condensed
- Fixed local token estimates staying too low once a conversation contained an image: a request carrying an image or PDF was dropped entirely from token-per-byte calibration, so an image left in the history disabled calibration for good; the separate image and PDF estimates are now subtracted and the text share is calibrated as usual
- Fixed the MCP row of the context breakdown always reading 0: MCP tools loaded on demand send no function definitions, and the MCP catalog section of the system prompt was counted under System prompt; that section now counts toward the MCP row, which is now labelled "MCP"
- Fixed the "Conversation Compaction Failed" card staying in the conversation after Retry: failed API requests and failed compactions now follow one display rule; the error stays recorded, but once the same work is attempted again (Retry, an automatic retry, or a later round) the earlier error is no longer drawn, so repeated failures show only the latest; a compaction failure now also renders with the same error card as an API error
- Fixed remove, edit, mode toggle, and reorder doing nothing in the input queue of a reopened task, such as after reloading the window: the task opens as a history display, and a queue action now turns it into the writable running task before applying the change
- Fixed image chips in sent messages never showing a thumbnail: the thumbnail bytes were returned as a Node Buffer, which the Webview message channel serialized into a plain object the chip could not read; they are now returned as a plain byte array
- Sending in a task that another window holds (read-only) now explains that the task is open in another Dline window and is read-only here; the notice sits between the auto-approve bar and the input instead of overlapping the bar, and wraps when long
- Fixed a long conversation shaking continuously while scrolled to the bottom
- The context figure computed before sending, including the compaction trigger, takes the previous request's server-reported usage as its baseline
- Fixed only some mid-stream disconnects being retried automatically; every stream disconnect now retries
- Fixed subagents failing immediately when an upstream HTTP/2 stream dropped while native tool arguments were still arriving: uncommitted, unexecuted tool calls are now discarded with the failed request and the same request is retried automatically, without executing a tool twice or counting the failed request's usage
- Fixed the model not receiving the image when `read_file` reads an image file
- Fixed pasted images sharing a name, and resource record files being attached as input
- Fixed the auto-approve bar showing through the expanded input queue; the queue list opens directly above the queue bar and covers the auto-approve bar on an opaque background
- Fixed the format badge in resource chips, such as PNG, wrapping onto two lines when space runs short
- Fixed a command that needs approval showing an extra Completed command card, whether it was approved or rejected
- Fixed tasks with more than 500 messages failing with `API Request Failed` (`timestamp ... already exists`) and asking for a manual retry when a deferred hosted tool call was resumed: saved messages are no longer mistaken for new ones, and such a local save failure no longer fails the API request
- Fixed LaTeX formula blocks using `\mathtt`, `\texttt`, `\mathsf`, `\mathbb`, `\mathfrak`, `\mathscr`, `\ell`, `\perp`, `\checkmark`, and similar commands failing to typeset and falling back to raw source; the required MathJax font data now ships with the Webview
- Fixed long tasks reading and rewriting the whole `messages.db` history on every update to the latest chat messages, which blocked the extension host for long periods; only the tail rows are now checked and replaced, so the cost no longer grows with task length, and the task view no longer copies every activity on each refresh
- Fixed native MCP function names carrying a server identifier generated randomly in each process, so after a restart or in another window an MCP call made under an earlier name could not find its server and per-tool auto-approval stopped applying: the identifier is now derived from the server name, with rejected characters replaced by `_`, and a tool whose name would exceed 64 characters or holds rejected characters is named by a hash of its name instead of being dropped
- Fixed a completed, already billed reply being discarded with `API Request Failed` when the model produced only reasoning it keeps hidden, with no text and no tool call: such a reply is now saved and continues like any turn without a tool call; an internal failure that no domain described no longer shows only an internal reference such as `error:provider.failed:<number>` but the actual error with credentials redacted, and a failure restored after a restart shows a readable explanation
- Fixed a transient failure while preparing a request (rebuilding the Profile's connection, validating credentials, building the prompt) surfacing at once as `API Request Failed`: it now shares the automatic retries and countdown of a failed send, as does preparing the request again after a Profile switch or a context truncation; a failure only the user can resolve, such as an invalid Profile, still shows at once
- Fixed the API failure prompt that offers Retry showing only the raw error: it now matches the error rows in the chat, naming an exhausted balance, an organization spend limit, or a signed-out Dline account; inside that prompt the balance card no longer adds a second Retry button that bypassed the prompt
- Fixed commands staying "Running" with no Cancel button in the Activities panel: after a window reload, an extension host exit, or a task close whose cancellation timed out, reopening the task now marks the commands and subagents that no process owns any more as interrupted, together with their chat command rows; a read-only opening (the task runs in another window) changes nothing; after a command moves to the background its Foreground/Background label updates at once instead of possibly staying on Foreground
- Fixed many checkpoints going missing: checkpoints are now committed and shown in step with the conversation. One is added before each model request and before context compaction whenever the conversation moved on or files changed, and a file-editing tool adds a restore point for the files it is about to change before it runs. Workspace changes come from the existing file watcher, whichever tool or person made them; changes by other tasks or by you can be restored but are not reported as this task's changes
- Fixed checkpoint file hashes being attached only after a later commit proved that files had changed, which made later file edits impossible to restore to a conversation boundary after `Restore Task Only`: every checkpoint now binds the workspace hashes at creation, committing changed files or reusing the previous hashes when unchanged; file and task restore remain independent, and only a checkpoint without an available Git snapshot falls back to task-only restore
- Fixed a sent message showing an extra image thumbnail at the bottom that duplicated the chip in its text
- Fixed image and file chips in sent messages not opening on click: a resource the task still holds now opens directly
- Fixed the composer placeholder staying visible after the input gains focus
- Fixed the task header's cumulative cost being lower than in the task history list: cost priced from the model's rates when the provider reports none, and subagent cost, now count toward the statistic
- Fixed the follow-up question card (ask_followup_question) and its options appearing in the middle of the reply: when the model keeps writing after it starts the question, the card now follows the whole reply
- Fixed earlier Thinking rows appearing twice after an API request failed or a stream dropped in the task
- Fixed a task reopened after an abnormal exit not staying at the bottom of the conversation: a command row left "running" by the previous session no longer turns off auto-scroll when it expands itself, while expanding a row by hand still keeps your reading position
- Fixed a task or panel that was at the bottom before being hidden returning to an older position when shown again: Virtuoso can reset its current bottom state during hidden layout, so the pre-hide snapshot now authorizes the first restore scroll while later retries still stop when the reader takes control
- Fixed the first message sent in a task opened from History (including one reopened after an interruption) clearing and reloading the chat, and a rejected send losing the typed input: the task keeps the same opening identity when the history view turns into the running task, so the conversation stays in place
- Fixed a strip of the auto-approve bar still showing under the open input queue: the queue list now opens flush against the Queue bar, with no gap or arrow
- Input queue entries are now separated from each other; queued entries show a list icon and steering entries a paper-plane icon
- Fixed the MCP response display-mode dropdown staying dark in a light theme
- Fixed the Claude usage tooltip splitting "Today Out:" from its value across two lines
- Fixed a tool call that needs approval, such as Web Fetch, showing two cards in the chat: the approval now takes over the card the call drew while streaming, so one call stays one row from preview through approval and running to its result, for every tool instead of only for commands; a call refused by the path boundary check after approval shows the refusal on that row; when hosted Web Search falls back to local search, the reason is shown on the local search card instead of on a separate failure card
- Fixed tool groups jumping while later rounds run: groups of tools such as read and search are now closed at each request round, so the next round's tools no longer join the previous round's group, a finished group's members and counts no longer change while a later round streams, and whether a checkpoint row was written between two rounds no longer affects grouping
- Fixed file links shown as `@<workspace>:<path>` in multi-root workspaces (tool group rows, diff edit rows, edit results, Markdown links, and so on) not opening: a link now opens the file under the named workspace root and jumps to its line number when one is given; `@<workspace>:<path>` and `<path>:<line>` written as inline code in a reply also open on click
- Fixed tool groups not actually being closed at each request round in the chat: successful request rows are hidden before grouping, so when no checkpoint row was written between two rounds, the next round's read and search calls still joined the previous round's group and a finished group's members and counts kept changing; rounds are now taken from the full message record, whether or not a checkpoint was written. Also fixed a low-stakes tool that needs approval, such as reading a file outside the workspace, appearing both in the tool group and as an approval card when it is the last message, and an earlier read disappearing from the tool group while the same file is read again in the same round
- Fixed Thinking from the same turn appearing after a turn-ending card such as `attempt_completion`, and a single call producing duplicate cards after a provider retry, message-window resynchronization, or reopening a completed task: reply rows now keep an order ahead of tool cards, provisional cards from failed requests are withdrawn, authoritative window sync removes stale partials, and restored completion interactions reuse their durable completion row
- Fixed long cards such as `attempt_completion` being impossible to read because the chat session stole their internal scrolling: a wheel gesture stays with a card while that card can still scroll, then hands off to the outer conversation at the card's edge
- Fixed checkpoints from several file edits in one turn collecting as blank standalone rows, and a task with an oversized final report failing to settle at the bottom when opened: checkpoints now persist their provider-turn, compaction, or file-edit source; a pre-edit restore point attaches to its tool card while remaining standalone when that card is outside the paged window; round and pre-compaction boundaries stay distinct and carry always-visible labels; ordinary chat-row height changes are followed only by the virtual list, and report content scrolls within half the viewport
- Fixed today's DeepSeek token counts
- Fixed adding, removing, and editing queued input waiting for the coalescing window before showing in the UI: an accepted change is published immediately, while drag reordering stays coalesced
- Fixed a `.agentignore` in a nested directory being ignored while walking the directory tree
- Fixed the mouse wheel failing to scroll the chat while the pointer rests on a short user message
- Fixed new tasks skipping the TaskStart hook until a window reload after a hook was created, toggled, deleted, or edited: hook discovery re-warms right after every change, and a task start waits up to 1.5 seconds for a scan in progress
- Fixed the message just sent, and the replies after it, not appearing after unlocking a large task from an earlier version and continuing it: importing the full history renumbers the messages, so the chat now replaces the window read while the task was read-only with the running task's latest page
- Dialogs stay within the Webview height and scroll their content, so a long dialog in a short sidebar no longer pushes its title and close button off screen
- Fixed imported tasks retaining almost all history after tool-message mismatches, Anthropic requests being rejected, Resume repeating completed compaction ranges, and queued input being lost or locked during compaction
- Fixed ordinary tasks and subagents failing immediately on upstream HTTP/2 stream errors; bounded retries now preserve request, task, and run identity, while a manual Retry can take over a pending automatic retry
- Fixed long `attempt_completion`, `qna_respond`, and `generate_report` output appearing only at the end, producing duplicate results, or disappearing after close and reopen
- Fixed multiple responses from one MCP call appearing as separate cards with repeated checkpoints; responses are now grouped into one collapsible card and execution copy is distinct from approval copy
- Fixed encrypted or redacted reasoning leaking into visible text, producing multiple Thinking or checkpoint rows, or leaving an empty Thinking placeholder after completion
- Fixed Background Edit taking editor focus, history-open failures entering the wrong task surface, and restored tasks showing blank input rows or stale Context Window and Focus Chain state
- Fixed an older task never opened since the upgrade showing only its recent chat in History and missing earlier turns in the conversation trajectory rail: a legacy chat history that has not been imported yet is now shown in full
- The trajectory rail's hover preview counts tool calls under the tool names the model calls today instead of the former names of renamed tools
- The new_task approval offers Start New Task and Regenerate Context again; after feedback through Regenerate Context, Start New Task on the next proposal opens the successor task
- Close Task cancels the commands and subagents still running in the task
- Reasoning that streams in just before a turn settles, such as after the last tool call, no longer fails the whole turn
- Requests that carry file details include the workspace roots with their repository identity (remote and latest commit) again
- Retry in the Activities panel works on a reopened task
- The Activities panel's mode badge no longer overflows in narrow layouts
- Usage statistics report every subagent request with role `subagent` instead of `reviewer` when the subagent's name contains "reviewer"
- A new_task approval still pending when VS Code restarts can be approved after reopening the task and opens the successor task, instead of being refused and the source task carrying on
- On a new_task handoff, text not yet sent in the source task's composer carries over to the successor task's composer
- Replying `/cmd:reportbug` to a question or a completed task starts the bug report, even when the model asks further questions before filing it
- The slash command and @ mention menus stay open while focus is briefly in another window or another part of VS Code, so picking continues on return without retyping
- A command run in a reused VS Code terminal no longer occasionally keeps showing as running until it times out after it has finished

### Release
- Each Insiders run now keeps only the latest draft and shows the current cumulative dev changes; pre-release and production notes come from the matching changelog version section, fail when that section is missing or empty, and verify that a production Release has exactly one correctly named, non-empty VSIX

## [0.11.2]

### Added
- Conversation trajectory rail: while the chat scrolls, a column of short separate bars appears on the right, one per user turn, white on dark themes and gray on light themes, with attempts set apart by their background. Hovering a bar previews that turn's user message, round count and tool calls; clicking it jumps to the user message, even when it is outside the loaded range. The trajectory is kept separately in the task's `trajectory.db`, linked back to the chat by message ts, and updated incrementally as messages arrive, without reading or rewriting the whole chat; it follows checkpoint restores and context compaction

### Changed
- Subagent cards start collapsed; click the header to expand one
- Each terminal partition keeps one idle terminal warm
- After a rate limit or telemetry pause (HTTP 429), the refused telemetry batch is kept unchanged and sent first once the wait ends, with the same request ID and content, instead of rejoining the pending data under a new request ID; data gathered during the wait forms its own batch, and neither the 429 nor its wait counts toward the 12-attempt and 24-hour retry limits
- The Account rollout is fetched only while both usage statistics and error reporting are on; turning either off, including in another window, leaves the rollout at once and deletes the rollout answers stored on the device instead of keeping them
- A model is custom only by its settings: Use custom model ID checked with the ID typed in, or Custom selected in the Bedrock model list; a model picked from the list is no longer custom, even on Ollama, LM Studio, or LiteLLM, behind a custom base URL, or outside the built-in catalog. Usage statistics and error reports name every model by its normalized model ID, custom models included, instead of replacing a custom model with `_custom`, so a typed ID is sent too (for example the region and AWS account ID in a Bedrock inference profile ARN); a custom model is additionally marked `custom: true` in usage statistics and has `model.custom` set to `true` in error reports
- Error reports send only the failure and runtime health events they list: a failed provider request is reported once, as `api.request.failed`, instead of also as `task.provider_api_error`; `task.error`, expected cancellations (such as a stopped request or a withdrawn review), and messages logged as warnings stay on the device, a failure logged only as a warning is no longer reported as an error, and only one sampler per extension host reports a performance budget breach. Records gain `error.site` (where the failure was caught), `error.fingerprint_version` (fingerprint version 3 groups by that place), `tool.name` for built-in tools, `failure.stage`, and `perf.*` for a performance budget breach; a development build marks its requests with `dline.is_dev=true`. The local loopback OTLP sink also accepts the error channel, and the `dline.errors.*` metrics are no longer recorded
- Telemetry to `otel.dline.cc` follows contract revision 5, and every request carries `X-Dline-Contract: 5`: device authorization uses `/auth/device/grant`, and usage statistics go to `/usage` as schema 5; error reports and runtime diagnostics go to `/v1/logs` as standard OTLP/JSON, joined by new production `/v1/metrics` (one delta window every 60 seconds) and `/v1/traces` channels. Dline's own paths carry no `/v1`, and feature flag requests likewise use `/features`
- Report Bug's temporary diagnostics authorization is issued by the service (`/auth/report-authorizations` and `/auth/exchange`); a failed authorization or telemetry request never prevents opening the issue

### Removed
- PostHog product analytics and error tracking are removed from both the extension and the Webview, and builds no longer inject their API keys; the earlier `/auth/device/exchange` authorization is removed too
- After the upgrade, usage statistics and error report queues that an earlier version left unsent on the device, the pairing code that was never used, and earlier authorization tokens are deleted rather than migrated or sent; the device keeps only metadata recording what was discarded and how much, without its content

### Fixed
- VS Code Terminal records an internal exit marker for every foreground command on WSL/Linux bash and Windows PowerShell, so stdout and exit codes remain reliable even without a project terminal configuration; new tasks prewarm immediately, slow cold terminals wait until Shell Integration is executable, and sequential commands with aggressive terminal reuse no longer create and discard a replacement terminal for every run
- With no workspace open on Linux, server/remote extension hosts such as Remote-WSL, SSH, and dev containers now default to the user's home directory (`~`), while local Linux desktop hosts continue to default to `~/Desktop`
- When an endpoint has no token-counting route (HTTP 404 or 405), Dline no longer requests a count again before every context estimate and uses its estimate instead
- Stable and Insiders now use independent sidebar, title action, command, task panel, diff, and code-review registrations when both are installed, so one Dline view no longer shows two action sets and neither extension fails on duplicate IDs; Insiders keeps Enter-to-submit in code-review replies but no longer declares extension shortcuts that compete with Stable defaults
- When several Dline builds or windows run at once, remote usage telemetry now takes turns sending instead of one window holding the sender indefinitely and leaving other builds unable to report; telemetry file names are unchanged
- Compacting context from the task header after a task completed no longer brings back Start New Task or other buttons after Condense; typing continues the task
- Pasting an image and typing text in a history task that is only displayed, then pressing Resume, now sends both; when an attachment is no longer available and the message is refused, the composer explains why instead of silently putting the draft back
- Fixed remote MCP servers registering new OAuth clients again and again: windows and overlapping connections now share and reuse one registered client and its tokens instead of overwriting or deleting each other's
- Commands waiting for a warm terminal at the same time are no longer given the same terminal
- The browser session card is organized by round: each round's checkpoint and thinking fold into the card instead of piling up as empty checkpoints below the screenshot. The checkpoint taken before the launch stays at the top of the card, and a checkpoint whose files changed during the session or that is checked out stays visible. Below the frame, a summary counts the calls by kind the way file reads are counted (for example 1 launch, 2 clicks · 4 rounds) and expands to list each round's checkpoint, thinking and actions; clicking an action shows its page. The whole card folds from its header down to the header and the page URL
- The browser session header reports the actual state (using, used, waiting for approval, not approved, interrupted or failed) instead of always saying "Dline is using the browser"
- Browser screenshot results are never shown as base64 text in the chat, including when the loaded message window starts mid-session or browsing continues after a cancelled request
- The kill command row follows the targeted command to its actual state (terminating, terminated, already finished, interrupted, or no running command matched) instead of always saying "Dline requested command termination"
- An MCP server with a connection error always offers Retry Connection; when the server answers 401 and asks for authentication, Authenticate is shown beside it instead of replacing it. The authentication message says the server answered 401, and a network failure names its reason (such as ECONNREFUSED and the address) instead of only "fetch failed"
- A manual `/compact` shows one card per compaction: its progress, the summary review (Condense Conversation / Regenerate Summary) and the landed result are all drawn on the same card, a regenerated summary returns to that card, and the finished card reads "Dline condensed the conversation". Sending only `/compact` (optionally with what to keep) waits for your input once you accept the summary instead of starting a request with an empty message; after a stopped compaction the composer accepts a reply directly instead of needing the task to be reopened and resumed
- Typing only `/compact` (or using the header compact button) while a completion, follow-up question, plan or similar dialog waits compacts right away; the summary review takes that dialog's place until it is accepted or stopped, and the dialog then waits again instead of receiving an empty answer; doing so while a tool waits for approval no longer rejects the tool
- The attempt_completion dialog opens as soon as the result is shown, so queued messages are sent at once; the checkpoint, change comparison and TaskComplete hook run while the dialog is open, and the next round still starts only after they finish
- Typing only `/compact` (optionally with what to keep) while the task works writes the summary right away beside the work in progress; its review opens once the round ends or before the next one starts, and the next request waits until you accept it. It no longer enters the input queue, so it is never taken as a dialog's answer at the end of a turn or sent as an empty message in a tool round
- The header compact button also works while the task runs, through the same immediate compaction; in every state it only compacts, without answering a waiting dialog or resuming an interrupted task. The context bar's token counts, progress bar and compact button are vertically centered
- Choosing Retry after a manual compaction ran out of retries continues the task once the compaction lands, instead of stopping on a state read from before the compaction was requested
- When the wrap-up request a subagent makes after a timeout or a finish request fails, the subagent reports the provider's actual error instead of five empty responses
- The page the browser opens after authorizing an MCP server or another remote service shows the Dline mark instead of the old Cline icon
- Compacting the context, a reply without tools, or Retry after a failed request no longer leaves two checkpoints next to each other: when nothing visible sits between them, an unchanged workspace reuses the previous checkpoint and a changed one replaces it with the new checkpoint
- API error cards such as an exhausted balance no longer carry their own Retry Request button; Retry, Start New Task, and replies come only from the task footer, and the card keeps only links such as top-up or sign-in
- Opening a long task saved by an earlier version from History and immediately pressing Resume or sending a message no longer leaves the chat stuck mid-history; the message just sent and the replies after it are shown
- Amounts in yuan show ¥ everywhere: subagent metrics, the activity panel and tiered model pricing no longer show CN¥, and balances no longer use the full-width ￥; every amount takes its symbol from the currency in the model's pricing, and an unlisted currency shows its code instead of $
- With Background Edit on, new files and files that used CRLF are saved with LF line endings; on Windows a new file previously took CRLF from VS Code's default end of line

## [0.11.1]

### Changed
- Usage statistics use the structured request body of telemetry contract v2: each batch carries client details, the minutes it covers, extension starts, and statistics per purpose, per model (at most 8, including the batch's busiest minute), and per provider (only those with failures or retries, at most 8), with the rest summed under `_other`; a batch covers up to 60 active minutes that need not be contiguous, stays within 32 KiB, and is checked locally against the service's rules before it is sent
- Usage statistics send a batch at most every 10 minutes and error diagnostics at most every 5 minutes by default, and both follow the time the service names for the next batch; after a rate limit or telemetry pause (HTTP 429), that channel sends nothing until the wait ends, which is the time the service asks for or else one minute doubling up to 30 minutes, plus up to 10% random spread and never more than 7 days, and which survives a restart; the two channels wait independently
- Rollout checks are less frequent: an ordinary build asks once an hour (previously every 30 minutes), and a development build every 5 minutes (previously every minute)
- Error diagnostics merge events with the same name, severity, error fingerprint, error class, provider, and model before sending, recording the number of occurrences and the first and last time; only attributes from the service's catalog are sent; one device keeps at most 50 new records per hour and 200 per day, and a request holds at most 100 records within 128 KiB, so records beyond these limits are dropped locally and their count is reported in the next request; a request that is too large is split in half and sent again

## [0.11.0]

### Changed
- The Account rollout reaches only devices that report Dline usage statistics, grouped by the device id the usage service issued; turning usage reporting off leaves the rollout at once and clears the cached rollout answers
- Only two rollout switches remain, Account (`account`) and Worktrees (`worktree-exp`): Web tools follow only the Web Tools switch in Settings → Features and no longer depend on a rollout, and OpenAI Responses WebSocket is no longer a rollout
- Usage reporting no longer stops for good after the service or its network edge refuses it: it tries again after 30 minutes and once whenever a VS Code window starts; a service that still refuses is left alone for another 30 minutes instead of being asked on every cycle
- Opening a history task shows the full-width Resume button in the footer again, so it is easy to notice; the composer's merged action button still resumes the task, and Cancel stays only in the composer button
- Error reporting is now on by default, and while it is on, failure events such as provider API errors and terminal hangs are sent to `otel.dline.cc` as OTLP logs: only the event name, severity, and short codes, never error messages, stack traces, paths, or Task, workspace, or account identity; error diagnostics and usage reporting each use their own token and queue, so turning one off deletes only its token and unsent data and leaves the other running; it can be turned off in Settings → About
- Usage statistics now describe each provider and model in more detail: failed and cancelled requests, cache and reasoning tokens, time to first output, output time, and request duration with histograms, failures by class (such as rate limited, overloaded, timeout, or network), and automatic retries with their waiting time; each extension start is counted once; a custom model (self-hosted, reached through your own endpoint, or not in the built-in catalog) is reported only as `_custom` and its ID is never sent; the per-request cost metric is no longer sent
- Error reports name the provider and model the same way as usage statistics, so a model ID containing `/` is no longer dropped and a custom model appears only as `_custom`; they also carry the error class, HTTP status, and duration of a failed provider request, and the report states whether it comes from the stable or Insiders build and which editor family (VS Code, Cursor, VSCodium, Windsurf, or other) runs Dline
- Dline no longer copies Cline data at startup (`~/.cline`, `Documents/Cline`, and the legacy Cline extension storage);
- Rollout checks are shared across the machine:
- `${env:VAR}` in an MCP configuration is resolved at connect time from the value saved for that server, then from the VS Code process environment; when neither exists, a masked input box asks for it, and the value is saved for that server only, in its own scope (global for a server from the global settings, the current workspace for a workspace descriptor server), never shared with other servers; cancelling or leaving it empty keeps the server disconnected with an error, and restarting the server asks again; each server row in the MCP settings gains "Clear Saved Variables", which forgets the server's saved values and reconnects it
- Account is now a gradually rolled out feature and hidden by default: the account sign-in choice in onboarding, the sidebar Account button,
- The composer's send, resume, queue, and cancel actions are merged into one action button:
- Images in a message are referenced in place with `<image_ref>`, and their pixels are sent to the model after the message
- Resources attached to queued entries and sent messages are shown as chips that open the resource
- For models that accept image input, images read by `read_file` and generated by `generate_image` are returned inside the tool result, tagged with their file name or Artifact ID
- Added `Ctrl + Alt + S`, which queues the composer draft directly as steering input, delivered at the running turn's next tool boundary; the `Shift + Q + Enter` / `Shift + S + Enter` chords and sending or queuing as plain text are removed, and the send key still queues while a task runs
- Added the "Load MCP Tools on Demand" setting, on by default: instead of sending every MCP tool's full definition as a native tool with each request, the model picks tools from the prompt's MCP catalog, grouped by server with only names and bounded descriptions, loads a tool's input schema with `load_mcp`, and calls it with `use_mcp_tool`; turning it off restores native MCP tools
- The context window panel lists MCP tool definitions as their own item instead of folding them into tool definitions
- When a model refuses a request as longer than its context window, including after its stream has started, the oldest settled history is truncated and the request resent at once, whether or not auto-compaction is on; this spends no automatic retry and shows no countdown, and repeats until the request fits; an error appears only when nothing more can be removed, that is when a single item is larger than the whole window
- An MCP call row stays open while the call runs; once its result arrives, the request and the response fold together into the header, which shows the tool name and reopens the row when clicked; when open, the tool name is a fixed title and only the tool description and arguments scroll beneath it; clicking the tool name folds the description and arguments on their own; the description and the arguments each have a subheading and the same framed box, arguments are listed by name, and string values are shown without JSON escape backslashes; and the card's scrollbars are thin and follow the theme (dark in a dark theme)
- In-work replies (Reply) and phase reports (Phase report) are now two clearly distinct minimal rows
- Tooltips now open only after the pointer rests on a button or label for 1 second, so moving across the interface no longer flashes them; a tooltip opened by keyboard focus still appears at once
- Paths in tool rows, file cards and in-progress hints are shown relative to the workspace; with several workspace folders open they are prefixed with the folder name (such as `backend/src/a.ts`); only a path outside the workspace stays absolute, and a relative path no longer gains a leading `/`; clicking still opens the reported path
- A call waiting for approval (read-only tools, terminal commands, edits, MCP, the browser, subagents and new tasks) now shows its full card only in the approval panel at the bottom, above Approve and Reject, instead of also in the chat; once approved or rejected the call appears in the chat, and a read-only call joins its round's tool group directly instead of first showing a separate "Dline wants to…" card
- The DeepSeek Flash model ID is renamed from `deepseek-v4-flash` to `deepseek-flash` (the default model follows) and accepts image input; remotely discovered DeepSeek models default to native tool calling and reasoning effort, and a capability the model listing states explicitly takes precedence
- Idle tasks no longer pay periodic CPU: storage skips the locked flush when nothing is staged, and task history writes no longer reconfigure components
- Consecutive read-only rounds (thinking plus reads, folder listings, searches, and definition or reference lookups, with no file change in between) fold into one row: collapsed, it reads like an ordinary tool group, with the checkpoint taken before the exploration, a summary of reads, searches, thoughts, and rounds, and every round's file and operation rows (click to open the file or show search results), folding away only the thinking and the checkpoints in between; clicking the summary lists each round with its checkpoint, thinking you can click to read, and tool calls; a file change, command, approval, error, or user input ends the row, and every checkpoint stays restorable
- Added telemetry to Dline's service at `otel.dline.cc`: usage telemetry is on by default and can be turned off in Settings → About; it counts provider and model usage for rankings
- The "Dline: Reconstruct Task History" command no longer replaces the whole task history: entries whose task folder still exists keep their workspace, favorite, and completion state, only missing tasks are added, and entries whose folder is gone are removed; an added task recovers its workspace from its first request, so the Workspace Only filter shows it again
- The task runtime now stores conversations in a journal; the first time an existing task is continued after upgrading, its conversation is imported unchanged and later requests carry the full history; per-task `state.json` replaces `snapshot.json`, and the migration imports only the queued inputs, not the earlier completion state
- Tasks from before the upgrade may reopen as interrupted, including tasks that were running or already completed, and continue through Resume or a new message; a task opened after upgrading cannot be continued by downgrading to an older Dline build
- Per-task storage moves to `messages.db`, `activities.db`, and `metrics.db`: an existing `ui_messages.jsonl` or `activities.json` is imported on first open and renamed to `*.migrated`, an existing `<task-id>.db` becomes `metrics.db`, and `api_conversation_history.jsonl` is left unchanged
- A task already open in another window is read-only in this window: input and footer actions are disabled, and replies, queue changes, compaction, activity controls, mode and Profile switches, and checkpoint restore are refused until you take the task over with force unlock in the lock banner
- Removed the deprecated per-mode OCA/OpenRouter model ID, model info and reasoning effort settings (cleaned once at startup), so continued tasks use the selected Profile's default reasoning effort; also removed the legacy `updateApiConfigurationProto` RPC and unused Groq/Hugging Face/Baseten model list state in the Webview
- Context compaction now uses the provider's official input count when available, or calibrates text estimates from real usage for the same provider, model, and API format; images and documents are counted separately, accepted passes are persisted, and multi-pass compaction resumes from the last safe checkpoint
- Subagent costs now use the effective model's billing currency, with unambiguous labels for Chinese yuan and Japanese yen and the currency code retained for unknown currencies

### Fixes
- Fixed a round's checkpoint sometimes appearing below the round's tool rows, right next to the following round's checkpoint: the checkpoint row now takes its place when the round starts, shows no Compare or Restore while the file snapshot is being committed, and is completed in place afterwards; when no file changed, the round reuses the previous snapshot instead of committing again
- Fixed the `rename` tool always failing with `Unexpected type` when the target file was not open in an editor: VS Code passed the new name as an array when renaming in a document it had not loaded, so Dline now loads the document first and cross-file renames work on files that are not open
- Fixed a setting changed in one VS Code window sometimes not reaching another open window: a window that saved an unrelated setting before it noticed the change took the new value without showing it, and a hand edit of `settings.json` that kept its stored revision was ignored; every window now shows the latest settings document
- Fixed workspace MCP servers (`.agents/mcp/` descriptors) showing no Auto-approve checkboxes
- Fixed task history losing tasks when the Documents folder has been moved
- Fixed a failed API request leaving only Retry / Start New Task in the chat with no error card
- Fixed the approval card for MCP tool calls and resource reads showing an empty server name and describing a tool call as accessing a resource; the card now shows the MCP server, the tool and its arguments
- Fixed two Checkpoint rows appearing directly one above the other
- Fixed two checkpoints still appearing after context compaction or a retry, one offering only Restore Chat and one with Compare and file restore: a chat-only checkpoint directly followed by another checkpoint is no longer shown, including in existing tasks when they are reopened; it stays visible only while it is the checked-out checkpoint
- Fixed the values of `${env:VAR}` references in the MCP settings being shown expanded on the settings page and written back to `mcp_settings.json` when a setting such as the timeout changed: the configuration now keeps the original references and resolves them only when connecting
- Added a Clear Saved Variables button to each MCP server row in the settings: a server that references `${env:VAR}` can forget the values saved for it and reconnect without expanding the row or failing to connect first
- Fixed project MCP servers (`.agents/mcp`) having no switch in the settings list: like other servers, the switch applies to the current workspace and is kept in Dline's local workspace state, and the descriptor file in the repository is not changed; a single task can still switch a server off from the task's MCP switches
- Fixed remote MCP servers that require OAuth failing to authenticate: servers rejected the `vscode://` callback when registering the client (`redirect_uris must only contain web uris`), the VS Code window that received the callback after a successful authorization could not find the authorization state (`No stored state found`), and after one failure every further **Authenticate** click failed as well. MCP now uses the same OAuth flow as the OpenAI Codex and Claude Code sign-ins: every click creates a fresh PKCE pair and state, and after you authorize, the browser returns directly to a local page on `127.0.0.1` served by the window that started the authorization, with no prompt to open VS Code; clients registered earlier register again automatically; an authentication failure now shows its reason; Dline registers with servers as the client "Dline" instead of "Cline"
- Fixed the MCP variable input box appearing before Dline was opened:
- Documentation links for MCP, rules, workflows, hooks, terminal, auto-approve and worktrees now open the matching pages on docs.dline.cc, the About telemetry and privacy links open the telemetry and privacy documentation on docs.dline.cc, and the account page's terms of service and privacy policy now point to dline.cc; the extension homepage is now dline.cc
- On Windows, a directory holding a file a task read
- Scroll areas such as What's New, an expanded exploration run and tool results no longer show a white scrollbar in dark themes: every scroll area in the Webview now uses the thin theme-colored scrollbar of the MCP card by default
- A rejected API key (such as a 401 `invalid_api_key`) no longer offers Retry:
- Fixed file checkpoints staying disabled for good after a task was reopened: a message an earlier session saved, such as "Checkpoints initialization timed out", no longer stops the new session from initializing, so checkpoint rows carry a restorable file hash again; rounds that arrive while initialization is still slow now wait for it instead of writing rows without a file snapshot
- Fixed messages sent after a task completed but before the reply box was ready being refused with "Dline cannot take input yet"; input in that window is now queued and delivered as the reply
- Fixed a phase report and the tool rows of the same turn swapping order when the report completes
- Fixed the input queue (Queue) failing to open in the sidebar and showing only a thin scrollbar
- Image chips no longer show the file name; only the thumbnail and the format badge remain
- Fixed image chip thumbnails disappearing once the image is queued or sent, or after it is cut and pasted in the input box
- Fixed the context bar dropping sharply when a compaction request is sent, for example from 560k to about 410k: the sending round replaced the provider's measured count of the conversation with a local estimate of the same conversation; the measured count now stays while the pass is sent and drops only once a pass is accepted and the conversation is actually condensed
- Fixed local token estimates staying too low once a conversation contained an image: a request carrying an image or PDF was dropped entirely from token-per-byte calibration, so an image left in the history disabled calibration for good; the separate image and PDF estimates are now subtracted and the text share is calibrated as usual
- Fixed the MCP row of the context breakdown always reading 0: MCP tools loaded on demand send no function definitions, and the MCP catalog section of the system prompt was counted under System prompt; that section now counts toward the MCP row, which is now labelled "MCP"
- Fixed the "Conversation Compaction Failed" card staying in the conversation after Retry: failed API requests and failed compactions now follow one display rule; the error stays recorded, but once the same work is attempted again (Retry, an automatic retry, or a later round) the earlier error is no longer drawn, so repeated failures show only the latest; a compaction failure now also renders with the same error card as an API error
- Fixed remove, edit, mode toggle, and reorder doing nothing in the input queue of a reopened task, such as after reloading the window: the task opens as a history display, and a queue action now turns it into the writable running task before applying the change
- Fixed image chips in sent messages never showing a thumbnail: the thumbnail bytes were returned as a Node Buffer, which the Webview message channel serialized into a plain object the chip could not read; they are now returned as a plain byte array
- Sending in a task that another window holds (read-only) now explains that the task is open in another Dline window and is read-only here; the notice sits between the auto-approve bar and the input instead of overlapping the bar, and wraps when long
- Fixed a long conversation shaking continuously while scrolled to the bottom
- The context figure computed before sending, including the compaction trigger, takes the previous request's server-reported usage as its baseline
- Fixed only some mid-stream disconnects being retried automatically; every stream disconnect now retries
- Fixed subagents failing immediately when an upstream HTTP/2 stream dropped while native tool arguments were still arriving: uncommitted, unexecuted tool calls are now discarded with the failed request and the same request is retried automatically, without executing a tool twice or counting the failed request's usage
- Fixed the model not receiving the image when `read_file` reads an image file
- Fixed pasted images sharing a name, and resource record files being attached as input
- Fixed the auto-approve bar showing through the expanded input queue; the queue list opens directly above the queue bar and covers the auto-approve bar on an opaque background
- Fixed the format badge in resource chips, such as PNG, wrapping onto two lines when space runs short
- Fixed a command that needs approval showing an extra Completed command card, whether it was approved or rejected
- Fixed tasks with more than 500 messages failing with `API Request Failed` (`timestamp ... already exists`) and asking for a manual retry when a deferred hosted tool call was resumed: saved messages are no longer mistaken for new ones, and such a local save failure no longer fails the API request
- Fixed LaTeX formula blocks using `\mathtt`, `\texttt`, `\mathsf`, `\mathbb`, `\mathfrak`, `\mathscr`, `\ell`, `\perp`, `\checkmark`, and similar commands failing to typeset and falling back to raw source; the required MathJax font data now ships with the Webview
- Fixed long tasks reading and rewriting the whole `messages.db` history on every update to the latest chat messages, which blocked the extension host for long periods; only the tail rows are now checked and replaced, so the cost no longer grows with task length, and the task view no longer copies every activity on each refresh
- Fixed native MCP function names carrying a server identifier generated randomly in each process, so after a restart or in another window an MCP call made under an earlier name could not find its server and per-tool auto-approval stopped applying: the identifier is now derived from the server name, with rejected characters replaced by `_`, and a tool whose name would exceed 64 characters or holds rejected characters is named by a hash of its name instead of being dropped
- Fixed a completed, already billed reply being discarded with `API Request Failed` when the model produced only reasoning it keeps hidden, with no text and no tool call: such a reply is now saved and continues like any turn without a tool call; an internal failure that no domain described no longer shows only an internal reference such as `error:provider.failed:<number>` but the actual error with credentials redacted, and a failure restored after a restart shows a readable explanation
- Fixed a transient failure while preparing a request (rebuilding the Profile's connection, validating credentials, building the prompt) surfacing at once as `API Request Failed`: it now shares the automatic retries and countdown of a failed send, as does preparing the request again after a Profile switch or a context truncation; a failure only the user can resolve, such as an invalid Profile, still shows at once
- Fixed the API failure prompt that offers Retry showing only the raw error: it now matches the error rows in the chat, naming an exhausted balance, an organization spend limit, or a signed-out Dline account; inside that prompt the balance card no longer adds a second Retry button that bypassed the prompt
- Fixed commands staying "Running" with no Cancel button in the Activities panel: after a window reload, an extension host exit, or a task close whose cancellation timed out, reopening the task now marks the commands and subagents that no process owns any more as interrupted, together with their chat command rows; a read-only opening (the task runs in another window) changes nothing; after a command moves to the background its Foreground/Background label updates at once instead of possibly staying on Foreground
- Fixed many checkpoints going missing: checkpoints are now committed and shown in step with the conversation. One is added before each model request and before context compaction whenever the conversation moved on or files changed, and a file-editing tool adds a restore point for the files it is about to change before it runs. Workspace changes come from the existing file watcher, whichever tool or person made them; changes by other tasks or by you can be restored but are not reported as this task's changes. The chat no longer hides or merges any checkpoint
- Fixed checkpoint file hashes being attached only after a later commit proved that files had changed, which made later file edits impossible to restore to a conversation boundary after `Restore Task Only`: every checkpoint now binds the workspace hashes at creation, committing changed files or reusing the previous hashes when unchanged; file and task restore remain independent, and only a checkpoint without an available Git snapshot falls back to task-only restore
- Fixed a sent message showing an extra image thumbnail at the bottom that duplicated the chip in its text
- Fixed image and file chips in sent messages not opening on click: a resource the task still holds now opens directly
- Fixed the composer placeholder staying visible after the input gains focus
- Fixed the task header's cumulative cost being lower than in the task history list: cost priced from the model's rates when the provider reports none, and subagent cost, now count toward the statistic
- Fixed the follow-up question card (ask_followup_question) and its options appearing in the middle of the reply: when the model keeps writing after it starts the question, the card now follows the whole reply
- Fixed earlier Thinking rows appearing twice after an API request failed or a stream dropped in the task
- Fixed a task reopened after an abnormal exit not staying at the bottom of the conversation: a command row left "running" by the previous session no longer turns off auto-scroll when it expands itself, while expanding a row by hand still keeps your reading position
- Fixed a task or panel that was at the bottom before being hidden returning to an older position when shown again: Virtuoso can reset its current bottom state during hidden layout, so the pre-hide snapshot now authorizes the first restore scroll while later retries still stop when the reader takes control
- Fixed the first message sent in a task opened from History (including one reopened after an interruption) clearing and reloading the chat, and a rejected send losing the typed input: the task keeps the same opening identity when the history view turns into the running task, so the conversation stays in place
- Fixed a strip of the auto-approve bar still showing under the open input queue: the queue list now opens flush against the Queue bar, with no gap or arrow
- Input queue entries are now separated from each other; queued entries show a list icon and steering entries a paper-plane icon
- Fixed the MCP response display-mode dropdown staying dark in a light theme
- Fixed the Claude usage tooltip splitting "Today Out:" from its value across two lines
- Fixed a tool call that needs approval, such as Web Fetch, showing two cards in the chat: the approval now takes over the card the call drew while streaming, so one call stays one row from preview through approval and running to its result, for every tool instead of only for commands; a call refused by the path boundary check after approval shows the refusal on that row; when hosted Web Search falls back to local search, the reason is shown on the local search card instead of on a separate failure card
- Fixed tool groups jumping while later rounds run: groups of tools such as read and search are now closed at each request round, so the next round's tools no longer join the previous round's group, a finished group's members and counts no longer change while a later round streams, and whether a checkpoint row was written between two rounds no longer affects grouping
- Fixed file links shown as `@<workspace>:<path>` in multi-root workspaces (tool group rows, diff edit rows, edit results, Markdown links, and so on) not opening: a link now opens the file under the named workspace root and jumps to its line number when one is given; `@<workspace>:<path>` and `<path>:<line>` written as inline code in a reply also open on click
- Fixed tool groups not actually being closed at each request round in the chat: successful request rows are hidden before grouping, so when no checkpoint row was written between two rounds, the next round's read and search calls still joined the previous round's group and a finished group's members and counts kept changing; rounds are now taken from the full message record, whether or not a checkpoint was written. Also fixed a low-stakes tool that needs approval, such as reading a file outside the workspace, appearing both in the tool group and as an approval card when it is the last message, and an earlier read disappearing from the tool group while the same file is read again in the same round
- Fixed Thinking from the same turn appearing after a turn-ending card such as `attempt_completion`, and a single call producing duplicate cards after a provider retry, message-window resynchronization, or reopening a completed task: reply rows now keep an order ahead of tool cards, provisional cards from failed requests are withdrawn, authoritative window sync removes stale partials, and restored completion interactions reuse their durable completion row
- Fixed long cards such as `attempt_completion` being impossible to read because the chat session stole their internal scrolling: a wheel gesture stays with a card while that card can still scroll, then hands off to the outer conversation at the card's edge
- Fixed checkpoints from several file edits in one turn collecting as blank standalone rows, and a task with an oversized final report failing to settle at the bottom when opened: checkpoints now persist their provider-turn, compaction, or file-edit source; a pre-edit restore point attaches to its tool card while remaining standalone when that card is outside the paged window; round and pre-compaction boundaries stay distinct and carry always-visible labels; ordinary chat-row height changes are followed only by the virtual list, and report content scrolls within half the viewport
- Fixed today's DeepSeek token counts
- Fixed adding, removing, and editing queued input waiting for the coalescing window before showing in the UI: an accepted change is published immediately, while drag reordering stays coalesced
- Fixed a `.agentignore` in a nested directory being ignored while walking the directory tree
- Fixed the mouse wheel failing to scroll the chat while the pointer rests on a short user message
- Fixed new tasks skipping the TaskStart hook until a window reload after a hook was created, toggled, deleted, or edited: hook discovery re-warms right after every change, and a task start waits up to 1.5 seconds for a scan in progress
- Fixed the message just sent, and the replies after it, not appearing after unlocking a large task from an earlier version and continuing it: importing the full history renumbers the messages, so the chat now replaces the window read while the task was read-only with the running task's latest page
- Dialogs stay within the Webview height and scroll their content, so a long dialog in a short sidebar no longer pushes its title and close button off screen
- Fixed imported tasks retaining almost all history after tool-message mismatches, Anthropic requests being rejected, Resume repeating completed compaction ranges, and queued input being lost or locked during compaction
- Fixed ordinary tasks and subagents failing immediately on upstream HTTP/2 stream errors; bounded retries now preserve request, task, and run identity, while a manual Retry can take over a pending automatic retry
- Fixed long `attempt_completion`, `qna_respond`, and `generate_report` output appearing only at the end, producing duplicate results, or disappearing after close and reopen
- Fixed multiple responses from one MCP call appearing as separate cards with repeated checkpoints; responses are now grouped into one collapsible card and execution copy is distinct from approval copy
- Fixed encrypted or redacted reasoning leaking into visible text, producing multiple Thinking or checkpoint rows, or leaving an empty Thinking placeholder after completion
- Fixed Background Edit taking editor focus, history-open failures entering the wrong task surface, and restored tasks showing blank input rows or stale Context Window and Focus Chain state

### Release
- Each Insiders run now keeps only the latest draft and shows the current cumulative dev changes; pre-release and production notes come from the matching changelog version section, fail when that section is missing or empty, and verify that a production Release has exactly one correctly named, non-empty VSIX

## [0.10.0]

0.10.0 is the production version number for the 0.9.4 content: a pre-release with the same number already occupied 0.9.4 in the registry, so the production release moves to a new even minor. Everything listed under 0.9.4 below is included in this release.

### Fixes
- TPM counts only the output tokens returned by the API; prompt and cache tokens no longer inflate the rate
- TODO lists are no longer reported as modified after format normalization
- The composer scrollbar track and maximum height are corrected, so long input keeps a visible scrollbar without exceeding the available height

### Release
- Version rules: production releases use an even minor (such as 0.10.x), pre-releases use an odd minor (such as 0.11.x), and Insiders follows the pre-release major and minor; packaging rejects a release tag with the wrong parity
- Registry publication currently targets Open VSX only and VS Code Marketplace publication is disabled; Open VSX fails when the same version is held by the other track instead of reporting a false success
- The full functional E2E stage of the release gate runs per folder in parallel, so a failure reruns only the failed folders

## [0.9.4]

### Features
- Parallel tool calls: when enabled, calls in one turn that need no manual approval can run concurrently; calls needing approval are confirmed one at a time, with a configurable maximum. Disabling the feature keeps execution serial
- `use_subagents` accepts up to 32 subagents per call, each with its own agent, API Profile, and timeout; items above the concurrency limit queue instead of being discarded
- Claude Code Profiles support OAuth sign-in and direct Anthropic Messages API requests; Anthropic API-key Profiles can optionally send Claude Code billing attribution, but the provider determines whether usage counts against a subscription
- Anthropic and Claude Code can declare hosted Web Search and Web Fetch independently where supported; actual execution depends on the provider response, and Force Remote does not silently fall back to local tools
- Claude Opus 5.5 is in the built-in model catalog and is the default for Anthropic and Claude Code; availability still depends on the provider account
- New bilingual documentation and brand experience: English is served at the site root and Simplified Chinese under `/zh-cn/`, User Guide and Developer Guide have separate sections, and new pages cover model usage and balance, capability scopes, Prompt Cache, telemetry, and task controls; the editor, Marketplace, and docs now share the refreshed robot icon and raden mascot
- Files of any type other than images, PDF, Word, and Excel can be pasted or dropped into the input box as text attachments, limited only by the 20 MB text input limit; files with binary content are rejected with a "Not a text file" message

### Changed
- Subscription usage identifies provider quota windows and snapshot age, and counts daily input/output tokens from Dline's own requests locally; sources without periodic usage polling retain an initial snapshot and manual refresh
- History tasks open in a lightweight, read-only message window while preserving their bound Profile, cross-window lock notice, and saved subagent metrics
- Command logs and shell diagnostics now live under the owning task's temporary directory, with a per-task size budget; commands without a task still use the process temporary directory
- Migration from Cline no longer imports task history that Dline cannot open or resume; settings, rules, workflows, and MCP configuration keep their existing migration paths
- When switching models, readable reasoning from the previous model becomes ordinary context tagged `<prior_model_reasoning>`; opaque reasoning and response IDs are not replayed to the new model, and a model-switch notice is added to the following user turn
- `dev-vX.Y.Z` pre-releases now use the Marketplace pre-release track of the production `tuvokyang.dline` extension and publish the same pre-release-marked VSIX to GitHub and Open VSX; Insiders remains a separate extension with timestamped versions, and the documentation site deploys continuously from `dev`
- Revised the system prompt to strengthen the guidance for proactively invoking Skills and Workflows
- `spawn_task` now always requires manual approval, even when Read project files auto-approves the subagent scope; YOLO and approve-all modes can still admit it
- Reading, searching, and writing inside the current task's temporary directory, such as its command logs, no longer asks for approval; other tasks' temporary directories and task artifacts stay outside project scope
- Web Fetch, Web Search, and code execution cards expand or collapse their details from the card title; a fetched Web Fetch page stays collapsed until expanded and is shown inside the card

### Fixed
- Fixed request-level approval appearing merely because hosted Web capabilities were declared; `Use Web` still governs Dline-owned local Web tools, and legacy hosted-approval snapshots require an explicit Resume only for a matching persisted history tail
- Fixed `generate_image` approvals, rejections, and reopened tasks losing the title, prompt, or image card; rejection makes no provider request
- Fixed replaying reasoning from another protocol as Anthropic thinking after switching providers, which could cause the request to be rejected
- Fixed silent Close Task failures and stale reply drafts appearing after a closed task is reopened
- Fixed duplicate approval/input submissions, accumulated API auto-retry failure cards, and command cards collapsing before streaming output finishes
- Fixed delayed process-listener/log-stream cleanup when commands finish, fail to start, or are cancelled, as well as cross-task background-command cancellation and missing trailing output
- Improved `replace_in_file` failure diagnostics for delimiters, SKIP markers, line labels, and the first divergent line, reject a SKIP tail that matches multiple locations instead of choosing the first, and reject a missing target instead of creating an empty file; Dline's own partial writes are no longer reported as external edits
- Fixed Profile switches retaining provider-specific replay state, model-switch notices, or inconsistent queued input, and stopped superseded provider streams from appending history or sending requests after Cancel and Resume
- Fixed history restore briefly returning to the home view or leaving an unusable Resume surface; every manual approval now has a clear title, while approval bodies and plan cards scroll internally for narrow windows or long content
- Optimized first paint when opening or resuming history tasks: the lightweight message window and visible task surface are published before secondary hydration such as activities, with identity fences for same-task reopen and stale requests
- Fixed the current task view remaining open after Delete Task confirmation; confirmation now dismisses the view immediately while backend deletion continues to own lock release, task detachment, and storage cleanup
- Webview render failures now show a recoverable fallback and report uncaught errors and Promise rejections to Dline logs with bounded, sanitized fields instead of leaving a blank gray panel
- Optimized incremental UI/API message persistence: no-op commits avoid disk reads, persisted tails can be safely truncated and appended, and baseline drift or interrupted tail writes fall back to transactional merge while keeping the task recoverable
- Fixed Anthropic and Claude Code hosted-tool turns stopping after `pause_turn` or when hosted calls were deferred behind client tool calls; continuation requests preserve hosted-tool identity and cumulative usage
- Fixed one failed Git tracker in a multi-root workspace removing all checkpoints; chat checkpoints remain available, with root-aligned references, legacy history migration, and partial-root diff, restore, completion, and command-file ownership
- Fixed Marketplace README links and images following the default branch and drifting from the installed package; packaging now pins them to the release tag or exact commit and restores the Changelog entry
- Fixed hosted Web Search and Web Fetch calls and results missing from later context; Anthropic, Claude Code, and OpenAI Responses now store hosted tool calls and replay them only to same-protocol requests that declare the same hosted tool, including in subagents; Anthropic and Claude Code share one Messages request-building and transport path
- Fixed the fast-mode route omitting the optional Claude Code identity headers, so the identity no longer depends on the selected speed
- Fixed attached PDFs being sent as truncated text; they are now sent whole as native documents within provider limits, and providers that declare no document input still fall back to text
- Fixed files such as PDFs dropped or pasted into the input box not being attached like images; dropping into the Webview requires holding Shift
- Fixed long input text being cut off without a scrollbar; text of 100 KB and more can be entered in full and scrolled
- Fixed images and PDFs attached to feedback entering context as base64 text; they are now sent as native image and document blocks, and tool-result images are projected natively for Responses, DeepSeek, Gemini, and Ollama
- Fixed slash commands such as `/cmd:newtask` being sent as plain text when typed as a reply to `attempt_completion` or `ask_followup_question`
- Fixed `new_task` handoffs skipping their approve-or-feedback card; rejecting a handoff now returns feedback instead of starting the next task
- Fixed `/cmd:compact` manual compaction failing outright on resume or after an unusable summary; it now retries twice, offers Retry and Start New Task once retries are exhausted, and rolls back the context indicator when compaction fails or is cancelled
- Improved compaction reliability: a `summarize_task` summary is accepted once the call closes, ignoring trailing text; correctable failures retry automatically and show the failure reason on the card; earlier summaries are no longer treated as user requests; and iterative passes no longer overwrite the task progress checklist
- Fixed tool results produced just before an automatic compaction being resent as orphaned results or dropped from history
- Fixed the newest reply not appearing when messages grow quickly, for example near the context limit or during compaction, and the reading position jumping in long histories with rows of mixed height, while older history loads, or while a reply streams
- Fixed reopened history tasks showing stale Running and Cancel controls on interrupted commands, and Activity Retry failing to restart a failed subagent in a reopened task
- Fixed a draft typed while switching between Plan and Act during a pending completion question not reaching that question
- Fixed terminal warm-up moving keyboard focus to the editor and sending typed text into an open file

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
