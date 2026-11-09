[中文](WHATS_NEW.md) | English

# What's New

The What's New dialog in the Dline sidebar shows the newest release section in English or Chinese to match the interface language. The webview build reads both editions, so edits ship with the next build. Every change is listed in the [changelog](../changelog/CHANGELOG_en.md).

<!--
Format rules, enforced by webview-ui/vite-whats-new.ts at build time:
- Each release starts with a bare "## X.Y.Z" heading, newest first. The first "##" heading is the
  release that ships, so do not put any other "##" heading above it.
- A release holds one flat "- " list. Indent a continuation line by at least two spaces.
- Inline syntax is limited to **bold**, `code`, and [text](https://...) links, without nesting.
- Every version bump adds a section here. The newest release must equal the version in
  package.json, and WHATS_NEW.md must carry the same version with the same number of items.
  Unit tests enforce both.
-->

## 0.13.2

- **English/Chinese UI**: follow VS Code or switch manually; model replies can follow your language automatically.
- **Marketplace images**: direct links for extension icons and demo GIFs reduce loading failures.

## 0.13.1

- **Subagent Auto Compact**: with Auto Compact on, subagents summarize context in memory and keep working.
- **Independent subagents**: choose each named agent's Rules, Skills, Workflows and MCP separately; approvals still apply.
- **DeepSeek daily pricing**: Beijing-time weekends and holidays show all-day off-peak rates; weekdays show peak windows.
- **OpenCode in 0.13**: use paid text models in one Profile with metered billing or Go plans.
- **Reliable saves in 0.13**: Done only closes settings; failed Profile saves show an error and reload saved values.

## 0.13.0

- **OpenCode provider**: one Profile covers its paid text models on a pay-as-you-go balance or a Go, Go Plus, or Go Teams subscription, and each model can be reached over OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages.
- **Easier Thinking reading**: basic Markdown layout, follow the newest line while content streams, pause following when you scroll up and resume at the bottom, and no more image loading or file opening from clicking the text.
- **More reliable settings and Profile saves**: Done only closes the page without waiting or saving again, and a failed Profile save shows an error and reloads the saved values without removing the editor.

## 0.12.2

- **Composer button interaction**: send, restore, queue, and cancel share a single button that queues the draft while a task runs and turns into cancel after a three-second hover on the queue state.
- **More reliable interruption and recovery**: a task that was interrupted, lost its window, or was reopened from history resumes with the result you expect instead of a scrambled or repeated state.
- **OpenCode provider**: one Profile covers all of its paid text models on a pay-as-you-go balance or a Go, Go Plus, or Go Teams subscription, and each model can be reached over OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages, with your plan deciding the prices and available models.

## 0.11.2

- **Conversation trajectory rail**: while the chat scrolls, a column of short bars on the right marks each user turn; hover one to preview the turn and click it to jump there, even outside the loaded range.
- **Manual compaction anywhere**: `/compact` shows one card per compaction and works while a task runs or a dialog waits, without sending an empty message.
- **More reliable interruption and recovery**: a task that was interrupted, lost its window, or was reopened from history resumes with the result you expect instead of a scrambled or repeated state.

## 0.11.1

- **More reliable interruption and recovery**: a task that was interrupted, lost its window, or was reopened from history resumes with the result you expect instead of a scrambled or repeated state.
- **More accurate input**: mentions, slash commands, pastes and drops are handled by source, and a file the model cannot read is still passed through unchanged.
- **Longer tasks stay responsive**: operations and refreshes no longer slow down as a task grows.
- **MCP tools on demand**: the "Load MCP Tools on Demand" setting (on by default) stops sending every MCP tool definition with each request; the model picks a tool from a prompt catalog and calls `load_mcp` for its parameter schema.
- **Composer button interaction**: send, restore, queue, and cancel share a single button that queues the draft while a task runs and turns into cancel after a three-second hover on the queue state.

## 0.11.0

- **More reliable interruption and recovery**: a task that was interrupted, lost its window, or was reopened from history resumes with the result you expect instead of a scrambled or repeated state.
- **More accurate input**: mentions, slash commands, pastes and drops are handled by source, and a file the model cannot read is still passed through unchanged.
- **Attachments stay available**: images and files are saved with the task, so they still open after you switch or reopen it instead of being scattered through message text.
- **Longer tasks stay responsive**: operations and refreshes no longer slow down as a task grows.
- **MCP tools on demand**: a new "Load MCP Tools on Demand" setting (on by default) stops sending every MCP tool definition with each request; the model picks a tool from a prompt catalog and calls `load_mcp` for its parameter schema.
- **Composer button interaction**: send, restore, queue, and cancel are merged into a single button that queues the draft while a task runs and turns into cancel after a three-second hover on the queue state.

## 0.10.0

- **Parallel tool calls**: calls in one turn that need no manual approval can run concurrently, with a configurable
  maximum.
- **Larger subagent batches**: `use_subagents` runs up to 32 subagents per call, each with its own agent, Profile, and
  timeout.
- **Claude Code and Anthropic**: OAuth sign-in, hosted Web Search and Web Fetch, and Claude Opus 5.5 as the default
  model.
- **Richer attachments**: PDFs are sent whole as native documents, and any text file can be pasted or dropped into the
  input box.
- **Reliability**: faster history reopen, sturdier compaction, and a TPM rate that counts only output tokens.
