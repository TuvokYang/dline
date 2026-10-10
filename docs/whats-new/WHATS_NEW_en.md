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

- **Reliable long-task recovery**: compaction uses provider counts or real-usage calibration, persists accepted passes, and resumes from a safe checkpoint.
- **Safe request retries**: ordinary tasks and subagents retry upstream HTTP/2 stream failures within a bound, while a manual Retry can take over a pending automatic retry.
- **Clear tool output**: long `qna_respond`, `generate_report`, and `attempt_completion` replies stream continuously, and multiple MCP responses share one card.
- **Concise Thinking and checkpoints**: encrypted reasoning shows one transient Thinking row without exposing ciphertext, and each user turn shows one restore baseline.
- **Stable editing, history, and cost display**: Background Edit keeps editor focus intact, restored tasks avoid blank or stale state, and subagents use the effective model currency.

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
