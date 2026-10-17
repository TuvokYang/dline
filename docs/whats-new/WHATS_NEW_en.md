[中文](WHATS_NEW.md) | English

# What's New

The What's New dialog in the Dline sidebar shows the newest release section of this file. The webview build reads it, so an edit ships with the next build. Every change is listed in the [changelog](../changelog/CHANGELOG_en.md).

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

## 0.11.0

- **Unified task runtime and recovery**: task state is driven by runtime events and a reducer, so interruption, resume and handoff follow an explicit state machine instead of being inferred when a history task reopens.
- **Semantic composer**: a structured composer replaces the plain text area, splitting the prompt by source (mentions, commands, pastes, drops) and passing unreadable content through to the model byte for byte.
- **Input resource store**: a task-level resource store and typed RPCs keep images and files as managed resources with the task instead of scattering them through message text.
- **Task performance**: chat history is now validated and replaced at the tail instead of being read and rewritten whole on every update, so the cost no longer grows with task length.
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
