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
- Root documentation follows the established pairing, such as `README.md` (English, the default) and `README_zh.md` (Chinese). Marketplace and in-extension readers see `README.marketplace.md`, which packaging copies over `README.md`; update it when the change affects that listing and run `src/__tests__/marketplace-readme-refs.test.ts`.
- Release notes follow the established pairing: `CHANGELOG.md` (Chinese) and `docs/changelog/CHANGELOG_en.md` (English).
- User-visible changes integrated into `dev` are recorded in the paired `Unreleased` sections. Follow repository-and-release for the changelog lifecycle and load dev-version-bump when freezing those entries into a version; routine Insiders updates do not bump package versions or What's New.
- The What's New dialog source follows the same pairing: `docs/whats-new/WHATS_NEW.md` (Chinese) and `docs/whats-new/WHATS_NEW_en.md` (English, the edition the dialog renders). Every version update adds a `## X.Y.Z` section to both; load dev-version-bump for the section rules, because the webview build rejects any other Markdown.
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

## 9. Verification

Verify at least:

- Chinese and English files cover the same behavior and sections;
- headings, frontmatter (`title` and `description` are required), links, anchors, code fences, and MDX syntax are valid;
- English pages contain no CJK text outside code;
- commands and UI labels match current source;
- referenced paths and assets exist;
- examples do not expose secrets or destructive defaults;
- no stale product names remain outside intentional migration context;
- `npm run docs:check` passes while iterating and `npm run docs:verify` (tests, content check, build, and dist check) passes before completion. Install the docs site dependencies first with `npm ci` in `docs/`; preview with `npm run docs`.

For substantial user-facing docs, request an independent review for technical accuracy and language parity.

## Completion report

Report both language files, navigation or asset changes, sources used to verify behavior, validation performed, and any environment-dependent statement that could not be confirmed.
