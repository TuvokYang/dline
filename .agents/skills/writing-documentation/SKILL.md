---
name: writing-documentation
description: Write or revise Dline documentation with evidence-based claims, bilingual Chinese and English deliverables under docs, current navigation and links, concise developer-focused prose, and verification of examples and assets.
---

# Writing Documentation

Use this skill for user-facing guides, feature pages, architecture documents, troubleshooting content, README material, and release documentation.

## Language contract

- User conversation and progress updates use Chinese unless the user requests another language.
- Files under `.agents/` use English.
- Documentation under `docs/` must provide Chinese and English deliverables for the same scope.
- Root documentation follows the established pairing, such as `README.md` (English, the default) and `README_zh.md` (Chinese).
- Release notes follow the established pairing: `CHANGELOG.md` and `docs/changelog/CHANGELOG_en.md`.
- Before creating a new documentation pair, inspect neighboring files and `docs/docs.json` for the local naming and navigation convention. Preserve an existing convention rather than mass-renaming historical files.
- If the target area has no discoverable bilingual naming convention, ask the user before inventing a new public URL structure.

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
- `docs/docs.json` navigation, redirects, and page metadata;
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

## 6. Use MDX components only when they help

Follow patterns already present in the current docs site.

- Use `<Frame>` for screenshots or embedded media when the target section uses that component.
- Use `<Card>` and `<Columns>` for navigation choices, not for ordinary paragraphs.
- Use `<Tip>`, `<Note>`, or `<Info>` for secondary context, caveats, and non-blocking guidance.
- Provide descriptive alt text and captions that explain why an image matters.
- Keep code fences copyable and label the correct language or shell.

Do not add components merely for visual decoration. Verify that every referenced asset exists and is packaged or hosted by the documented path.

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

- update `docs/docs.json` only when navigation, redirects, or metadata actually changed;
- link to current pages rather than removed legacy routes;
- verify inbound and outbound links for renamed pages;
- avoid duplicate pages that explain the same contract differently;
- keep language counterparts discoverable according to the site's current localization convention.

## 9. Verification

Verify at least:

- Chinese and English files cover the same behavior and sections;
- headings, frontmatter, links, anchors, code fences, and MDX syntax are valid;
- commands and UI labels match current source;
- referenced paths and assets exist;
- examples do not expose secrets or destructive defaults;
- no stale product names remain outside intentional migration context;
- the docs build or the project's available documentation validation passes.

For substantial user-facing docs, request an independent review for technical accuracy and language parity.

## Completion report

Report both language files, navigation or asset changes, sources used to verify behavior, validation performed, and any environment-dependent statement that could not be confirmed.
