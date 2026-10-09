[中文](WHATS_NEW.md) | English

# What's New

The What's New dialog in the Dline sidebar shows the newest release section of this file. The webview build reads it, so an edit ships with the next build. Every change is listed in the [changelog](../changelog/CHANGELOG_en.md).

<!--
Format rules, enforced by webview-ui/vite-whats-new.ts at build time:
- Each release starts with a bare "## X.Y.Z" heading, newest first. The first "##" heading is the
  release that ships, so do not put any other "##" heading above it.
- A release holds one flat "- " list. Indent a continuation line by at least two spaces.
- Inline syntax is limited to **bold**, `code`, and [text](https://...) links, without nesting.
- The newest release must match the major.minor version in package.json, and WHATS_NEW.md must
  carry the same version with the same number of items. Unit tests enforce both.
-->

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
