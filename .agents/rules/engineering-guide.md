# Dline Engineering Guide

This file records high-signal project conventions that are easy to miss and expensive to rediscover. Add guidance only when it cannot be learned quickly from nearby code, tests, or an existing specialized rule.

Rules describe project architecture and conventions. Skills teach concrete work techniques. Workflows organize long implementation and operational sequences.

## File editing

- Modify existing files with `replace_in_file`; use `write_to_file` only for new files.
- Re-read a file before retrying a failed replacement or when the environment reports a recent modification.
- Combine independent search/replace blocks for one file when that keeps the change atomic and reviewable.
- Preserve unrelated and unknown workspace changes. Do not use formatting or bulk replacement to absorb another task's work.

## Source file size

- A hand-written source file must not exceed 2,000 physical lines.
- Do not split a file merely because it is large while its responsibilities, change reasons, and dependency direction remain coherent. When a file approaches the limit, extract stable responsibilities or dependency boundaries rather than creating arbitrary forwarding fragments.
- Generated code, machine-managed lockfiles and snapshots, and fixture data are not hand-written source files and must not be split solely to satisfy this limit.

## Searching ignored directories

`search_files` runs through ripgrep, which honours `.gitignore` plus the scan
rules compiled by `IgnoreController`. `node_modules`, `dist`, `build`, `out` and
`tmp` are in the built-in floor (`src/core/ignore/IgnoreController.ts`), so a
search rooted above them returns nothing from inside them.

Naming such a path directly is treated as a deliberate descent: pruning bounds
discovery cost, and a caller that already narrowed the walk has bounded it. The
result then says the path is normally pruned, so an empty search cannot be
misread as "the symbol does not exist".

An `.agentignore` restriction is a permission, not a cost decision, and is never
lifted this way. `search_files` refuses those paths and says so; do not reach for
the terminal to work around it.

`list_files` sets `gitignore: false` and applies only the IgnoreController rules,
and `read_file` does not filter at all. When a search of a dependency returns
zero, confirm with `read_file` before concluding the content is absent.

## Start from real entry points

Before editing, inspect the owning implementation, tests, generated contracts, and package scripts. Common navigation rules:

- core API providers: `src/core/api/providers/`;
- model catalog: `src/core/model-registry/`;
- task lifecycle: `src/core/task/` and `src/core/task/runtime/`;
- Webview: `webview-ui/src/`;
- host adapters: `src/hosts/`;
- Proto definitions: `proto/dline/`;
- generated code: `src/shared/proto/`, `src/generated/`, and generated Webview clients;
- prompt profiles/tools: `src/core/prompts/profiles/` and `src/core/prompts/tools/`;
- storage: `src/shared/storage/` and `src/core/storage/`.

Check `package.json` before choosing a verification command. Current primary scripts include `check-types`, `lint`, `format`, `test:smoke`, `test:run`, `test:e2e:work`, `protos`, `package`, and `vsix`.

## Error-handling boundaries

- Handle each failure at one owning boundary: the caller that can recover, translate it into the operation's public failure, or terminate that operation. When an outer call boundary already catches the failure, inner functions must propagate it rather than catch it again.
- Do not scatter `try-catch` blocks through a call chain. Catching only to log and rethrow, wrap the same error again, return an unexplained default, or hide a broken invariant is prohibited. Report a failure once at its owning boundary.
- Do not add speculative `try-catch` around deterministic computations, statically checked operations, or operations whose validated inputs and contract rule out the failure being caught. Type checking does not make filesystem, network, process, or persistence operations infallible; handle their actual failures at the appropriate boundary.
- Use `finally` for required resource cleanup. A distinct rollback or recovery operation belongs to the boundary that owns it, not to repeated defensive catches in its callees. Cancellation must retain its existing meaning and must not be converted into success.

## Spec design: do not evade defects with defensive programming

Do not use defensive programming to evade root-cause fixes or required behavior. A spec must not invent unnecessary invariants, then prescribe filtering, disabling features, dropping data, or stale-data substitution to satisfy them. Limit failure to the operation that actually failed.

**Example:** a navigator needs message-index jumps and per-interval tool counts, not strictly increasing timestamps. Declaring timestamp disorder a permanent error that hides the navigator is a contract defect; filtering points or showing an old snapshot only conceals it. Fix timestamp publication independently, aggregate every index interval, and let a missing target end only that click—not disable other points or stop updates.

## Test and verification contracts

- Tests assert observable results against an independent oracle: inputs, parsed structure, ordering, state transitions or side effects. Each case must distinguish a plausible incorrect implementation.
- `expect(text).toContain("implementation-owned prose")`, copied labels/endpoints, tag presence and string snapshots alone do not establish behavior. Exact tokens belong in tests when a parser, protocol, compatibility or accessibility consumer depends on them; exercise that consumer.
- Assigning the same source value to both sides, deriving expected and actual through the same implementation, or returning a mock value and only asserting that value is not an independent test.
- Remove such low-value assertions in a touched test scope. Replace them with the underlying invariant when one exists. This is not a ban on text: a caller-visible error matched by downstream code is a testable contract.
- Generated snapshots record intentional aggregate output; regenerate them with repository commands and pair them with focused semantic checks.

Load `use-vitest` for execution/snapshot methods and `use-e2e` for host integration and diagnostics.

E2E evidence must match the changed boundary. Focused functional tests are for stable regressions; full functional runs only in production validation or explicit investigation. Dev fault-injection and pressure/soak are not routine CI/release gates. Required CI/release uses one tested VSIX, one Linux work smoke, then four daily workflows each on Linux/macOS/Windows. Load `use-e2e` for tiers, source/package mode, dist lock, run isolation and diagnostics, and `e2e-validation` for the multi-stage validation procedure. Do not destroy active locks/artifacts, inflate timeouts, or broaden tests instead of diagnosing the first failed boundary.

## Type checking and emission

`npm run check-types` checks the root project and `webview-ui/tsconfig.app.json` without emitting. Root tsconfig keeps `noEmit: true`; `scripts/build-tests.js` and `watch-tests` opt into output with `--noEmit false`. Production bundling uses esbuild through `npm run package`.

`tsc -b` is project-references build mode, not a no-output check. `npm --prefix webview-ui exec -- tsc -b` still runs from the original process directory: npm --prefix changes package resolution, not cwd. For an explicitly scoped check, pass `--noEmit -p <config-path>`; select a different execution directory with workdirectory.

## Protobuf and ProtoBus

Dline uses Protobuf across application/Webview services, host bridges, and retained standalone transports. Sources live under `proto/dline/` with `dline...` namespaces and imports rooted under `dline/`. Webview RPC is generated ProtoBus envelopes over VS Code `postMessage`, not a network gRPC socket.

- Proto (or the owning state-key generator for generated Settings/Secrets) is authoritative. Never hand-edit generated projections; fix their source or generator.
- Field numbers retain their meaning. Never reuse or renumber a field for another purpose; reserve removed numbers/names when compatibility requires it. Define presence/default, errors/cancellation, and old-consumer behavior explicitly.
- Generated service/method registration owns RPC wiring. Do not add parallel registries or ad-hoc messages where an RPC owns the interaction. Keep transport DTOs at the boundary and convert to domain/runtime values.
- A generated field is not automatically part of persistence, validation, Controller projection, or UI/CLI defaults; both conversion directions and the real round trip must agree.

Load `changing-protobuf-contracts` for schema, generation, handler/client, compatibility and verification methods with complete examples. A separate workflow is not required for an ordinary protocol edit.

## Providers and ModelRegistry

Model metadata authority remains in ModelRegistry, not a deleted static provider JSON catalog. Load `add-new-provider` for implementation techniques and model-source/plan changes; load `integrate-new-provider` for a new provider's long cross-layer integration workflow.

Responses API support is driven by API format and provider capabilities. Do not add an `isNextGenModelProvider()` branch or model-family prompt variant.

## Prompt and tool changes

Follow `prompt-engineering` for model-visible contracts and canonical/i18n ownership. Load `reviewing-prompt-contracts` for review techniques, `add-new-tool` for implementation skills, and `integrate-new-tool` for the complete long integration workflow.

## Capabilities metadata

Skills and workflows are advertised from YAML frontmatter. Both name and a non-empty, task-specific description are required; workflow names match their .md filenames and skill names match their directories. Parser fallbacks are not authoring defaults. Load `write-workflow` for metadata examples and workflow authoring techniques.

Standard advertises enabled capabilities with their loaders. Lite omits the skill catalog and load_skill/load_workflow tools; explicit skill/workflow slash injection remains a separate user entry point. Supporting references are read explicitly.

## State and storage keys

Follow `storage` for owner, scope and authority before adding persistent state; load `changing-persistent-state` for mutation, migration and durability techniques. Keys, repositories and UI/Proto round trips must use their owning contracts rather than direct ExtensionContext persistence or ad-hoc files.

## Loading, cancellation, and recovery UI

A UI row that shows running state must also define cancelled, interrupted, failed, restored, and completed projections. Prefer canonical Task phase, persisted interaction/activity state, and causal identities over heuristics based only on whether a message is last.

When streaming work is cancelled, close owned resources and persist the terminal state. Tests should cover cancellation before first output, during streaming, after durable tool result, and after restart when applicable.

## Networking

Follow `network`. Extension/core code must not introduce global `fetch`, an unconfigured Axios client, or a third-party SDK transport that bypasses proxy support and provider-attempt observability.

## Documentation language

- User conversation uses Chinese unless explicitly changed.
- `.agents` files use English.
- `docs/` changes require Chinese and English deliverables for the same scope.
- Root README and changelog files follow their established bilingual pairs.

## Documentation after development

When a development task is complete, load `writing-documentation` before editing documentation, including the paired changelog and What's New files.

- Update documentation only for behavior the task actually changed. Leave unrelated pages, released sections, and files that do not describe the change untouched.
- Documentation includes everything under `docs/` and the paired user-facing files: `CHANGELOG.md` with `docs/changelog/CHANGELOG_en.md`, and `docs/whats-new/WHATS_NEW.md` with `docs/whats-new/WHATS_NEW_en.md`.
- A change with no user-noticeable capability needs no What's New entry, even when it is a fix worth recording in the changelog.
- What's New is version-scoped: the dialog appears only when the shown version differs from the last acknowledged one, so a build that does not change the version does not show it again. Never invent a section to force it to appear.

### What's New and changelog content

`CHANGELOG.md` (Chinese) and `docs/changelog/CHANGELOG_en.md` (English) record what shipped. `docs/whats-new/WHATS_NEW.md` (Chinese) and `docs/whats-new/WHATS_NEW_en.md` (English, the edition the dialog renders) present the highlights of one release. Users read all four; maintainers and the implementation are not the audience.

- An entry states behavior a user can observe. Class, table, protocol, and endpoint names are not entry content, and internal work appears on neither surface unless it changes what a user can observe.
- One entry per change; unrelated changes stay separate.
- Both pairs cover the same changes in the same order. The languages may phrase naturally but must not differ in features, defaults, limits, or support status.

What's New carries at most five entries per version, each within 128 characters counting the bold lead-in, and only these three kinds: a feature the user can notice, a stability improvement, or a fix users hit. A change shipped by an earlier release is not restated as new.

New work belongs under `Unreleased` until the release that carries it is tagged. Published sections describe what users already have; trimming and rewording apply to unreleased entries and to the next version, not to the record of what already shipped.

The file format is a build contract: a bare `## X.Y.Z` newest heading, one flat `- ` list with two-space continuations, and only `**bold**`, backtick code, and absolute `https://` links inline. Run the What's New test at `webview-ui/src/__tests__/vite-whats-new.test.ts` after editing either edition.

## Git and release work

Follow `repository-and-release`. Reusable instructions must not hard-code a remote alias, repository owner, or URL. Ordinary PRs come from independent branches into `dev`; only an integrated and verified `dev` candidate may be promoted to `main` and tagged for production.
