---
name: writing-documentation
description: Revises Dline documentation with evidence-based claims, bilingual deliverables, factual changelog entries, and distinct What's New highlights. Use when writing or correcting pages under docs, README material, CHANGELOG.md, or the What's New editions. Do not use for code comments or internal design notes.
---

# Writing Documentation

Use this skill for user-facing guides, feature pages, architecture documents, troubleshooting content, README material, and release documentation.

For changelogs and What's New, use section 9.

## Language contract

- User conversation and progress updates use Chinese unless the user requests another language.
- Files under `.agents/` use English.
- Documentation under `docs/` must provide Chinese and English deliverables for the same scope.
- Root documentation follows the established pairing, such as `README.md` (English, the default) and `README_zh.md` (Chinese). Marketplace and in-extension readers see `README.marketplace.md`, which packaging copies over `README.md`; update it when the change affects that listing and run `src/__tests__/marketplace-readme-refs.test.ts`.
- Release notes and the What's New editions follow their own pairing and wording rules: `CHANGELOG.md` (Chinese) with `docs/changelog/CHANGELOG_en.md` (English), and `docs/whats-new/WHATS_NEW.md` (Chinese) with `docs/whats-new/WHATS_NEW_en.md` (English, the edition the dialog renders). Section 9 covers those files.
- The docs site is Astro Starlight. Every site page is a pair with the same slug: English at `docs/src/content/docs/<slug>.mdx` (served at the site root) and Chinese at `docs/src/content/docs/zh-cn/<slug>.mdx` (served under `/zh-cn/`), as declared in `docs/src/data/locales.mjs`. `npm run docs:check` fails when either edition is missing.
- Ask the user before inventing a new public URL structure only for documentation outside the site content tree.

Bilingual pages must remain behaviorally equivalent. They may use natural phrasing for each language, but must not describe different features, limits, defaults, or support status.

## 1. Establish the reader outcome

Define what the reader should be able to do after reading the page. Prefer a concrete problem, workflow, or decision over a broad technology topic.

A useful title communicates the outcome or problem. Avoid titles that only list implementation technologies unless those technologies are the subject.

Use evidence instead of unsupported adjectives. Replace claims such as "fast", "production ready", or "seamless" with measured behavior, explicit limits, verified compatibility, or remove the claim.

Never invent performance numbers, support guarantees, screenshots, commands, or product behavior.

## 2. Inspect current product evidence

Before writing, read:

- the relevant implementation and tests;
- current UI labels, settings, commands, and error states;
- `docs/src/data/navigation.mjs` (sidebar and `unlistedSlugs`), `docs/src/data/redirects.mjs`, `docs/src/data/sections.mjs`, and page frontmatter;
- related documentation and cross-links;
- the current package scripts and platform behavior for command examples;
- existing visual assets and their actual dimensions/content.

Treat old docs as evidence to verify, not as an authority. Remove or update stale Cline branding unless the page explicitly documents migration or compatibility history.

## 3. Plan both language deliverables

Create one content outline shared by the Chinese and English versions:

1. reader goal and prerequisites;
2. where the feature is available;
3. the shortest successful workflow;
4. a realistic example;
5. limits, permissions, failure paths, and recovery;
6. related pages and next actions.

Do not finish one language and leave the other as a placeholder. Track both files in the same documentation task and validate them together.

## 4. Write for action

Start with what the feature enables and the conditions required to use it. Then show where to find it and how to complete the workflow.

Use realistic project examples that match current Dline interfaces. Avoid toy code that teaches a path the product does not support.

Keep prose direct and scannable:

- prefer short paragraphs;
- use headings for real topic changes;
- use numbered lists for ordered procedures;
- use bullets for independent options or reference items;
- avoid repetitive `**Label**: description` lists when natural prose is clearer;
- remove filler, corporate language, and repeated conclusions;
- do not use emoji or em dashes in project documentation.

Do not anthropomorphize Dline or assign a gender. Refer to the product as `Dline`, `the agent`, or `it`, according to sentence context.

## 5. Document contracts and failure paths

For user-visible features, include the applicable details:

- prerequisites and permissions;
- supported hosts or environments;
- configuration and defaults;
- cancellation, timeout, retry, and cleanup behavior;
- storage or privacy impact;
- expected success output;
- common failures and actionable diagnostics;
- compatibility or migration constraints.

Do not hide a limitation behind promotional language. If behavior is not verified, label it as unverified or omit it.

## 6. Use Starlight components only when they help

Follow patterns already present in the current docs site. Import components explicitly from `@astrojs/starlight/components`; the content check rejects unimported components and Mintlify-only components or frontmatter keys (`sidebarTitle`, `icon`, `iconType`, `mode`, `api`, `openapi`).

- `Aside` for secondary context, caveats, and non-blocking guidance.
- `Steps` for ordered procedures.
- `Tabs`/`TabItem` for alternatives such as platforms or shells.
- `CardGrid`/`LinkCard` for navigation choices, not for ordinary paragraphs.
- Embed images as `![descriptive alt](@docs-assets/<dir>/<file>)`; the alias serves the repository's `assets/docs/`. Root-relative image paths are rejected. Regenerate UI captures with the demo specs (`npm run e2e:demo`) and Marketplace media with `npm run demo:media` instead of hand-editing them.
- Keep code fences copyable and label the correct language or shell.

Do not add components merely for visual decoration. Verify that every referenced asset exists.

## 7. Keep commands safe and current

Read project scripts before documenting commands. Use the target platform's shell syntax and label shell-specific examples.

Do not tell users to:

- install, delete, overwrite, force-push, publish, or change credentials without explaining the side effect and required authorization;
- use obsolete `cline` commands when the supported interface is Dline, except in a migration guide;
- copy secrets into examples;
- rely on a fixed repository, remote alias, personal path, or maintainer account.

Prefer placeholders such as `<repository>`, `<path>`, `<token>`, and `<version>` where values are environment-specific.

## 8. Navigation and cross-links

After writing both language versions:

- add every new page slug exactly once to `sidebar` in `docs/src/data/navigation.mjs`, under the right section group, or to `unlistedSlugs`;
- when renaming or removing a page, add a base-free entry to `docs/src/data/redirects.mjs` that points at the final current page, with no redirect chains and no redirect that shadows an existing page;
- write internal links as base-free root-relative paths that end with `/` (no relative paths, no `.md`/`.mdx` targets, no site base); English pages link only English pages and Chinese pages link only `/zh-cn/...` pages;
- link to current pages rather than removed legacy routes;
- verify inbound and outbound links for renamed pages;
- avoid duplicate pages that explain the same contract differently;
- keep language counterparts discoverable according to the site's current localization convention.

## 9. Write changelogs and What's New

`CHANGELOG.md` and `docs/changelog/CHANGELOG_en.md` record release changes by category. Each entry states what changed in one concise sentence.

What's New presents selected features, stability improvements, and fixes for users. The dialog renders its English edition.

| Situation | Result |
|---|---|
| finished work, not yet released | `[Unreleased]` in both changelogs, `## Unreleased` in both What's New editions |
| cutting a version | those entries move into the tagged `## X.Y.Z` section; load `dev-version-bump` for the version range and file set |
| changelog entry | one concise sentence stating what changed |
| What's New entry | bold lead-in, then one sentence of behavior |
| What's New budget | at most five entries per version, each within 128 characters counting the lead-in |
| the other language | same changes, same order, same count; natural phrasing, no differing limits |

Changelog entries state the actual change directly:

```text
- Fixed temporary support telemetry deletion blocked by a file lock.
- Added English and Chinese interface selection.
```

A What's New entry leads with the outcome in bold and stops there:

```text
# a label with no behavior
- **MCP tools on demand**

# outcome, consequence, and cost
- **发送区只剩一个按钮**：发送、恢复、排队、取消合并为一个按钮，任务运行时发送即排队，悬停 3 秒转为取消。
```

The shape is a build contract for the What's New editions: the newest section is a bare `## X.Y.Z` heading, each section is one flat `- ` list with two-space continuations, and inline syntax is limited to bold, backtick code, and absolute `https://` links without nesting. Changelogs use `## [X.Y.Z]`.

| Mistake | Correction |
|---|---|
| two unrelated changes joined by "and also" | split into separate entries |
| an older release's feature restated as new | drop it, or return it to its own section |
| a What's New entry lists implementation details | summarize the feature, stability improvement, or fix |
| a translation copied sentence by sentence | describe the same behavior naturally in each language |

## 10. Verification

Verify at least:

- Chinese and English files cover the same behavior and sections;
- headings, frontmatter (`title` and `description` are required), links, anchors, code fences, and MDX syntax are valid;
- English pages contain no CJK text outside code;
- commands and UI labels match current source;
- referenced paths and assets exist;
- examples do not expose secrets or destructive defaults;
- no stale product names remain outside intentional migration context;
- `npm run docs:check` passes while iterating and `npm run docs:verify` (tests, content check, build, and dist check) passes before completion. Install the docs site dependencies first with `npm ci` in `docs/`; preview with `npm run docs`.

For the release notes and What's New files, run:

```bash
npx vitest run webview-ui/src/__tests__/vite-whats-new.test.ts src/__tests__/extract-changelog-section.test.ts
```

The first fails on a malformed section, on a first version that differs from `package.json`, and on editions that differ in version or count. The second treats an empty released section as an error during extraction. Then read the diff for the budgets, the bilingual count, published sections left untouched, and UTF-8 with LF endings.

For substantial user-facing docs, request an independent review for technical accuracy and language parity.

## Completion report

Report both language files, navigation or asset changes, sources used to verify behavior, validation performed, and any environment-dependent statement that could not be confirmed. For changelogs, report the change records added or reworded; separately report which highlights were selected for What's New or why it was left unchanged.
