# Dline Engineering Guide

This file records high-signal project conventions that are easy to miss and expensive to rediscover. Add guidance only when it cannot be learned quickly from nearby code, tests, or an existing specialized rule.

## File editing

- Modify existing files with `replace_in_file`; use `write_to_file` only for new files.
- Re-read a file before retrying a failed replacement or when the environment reports a recent modification.
- Combine independent search/replace blocks for one file when that keeps the change atomic and reviewable.
- Preserve unrelated and unknown workspace changes. Do not use formatting or bulk replacement to absorb another task's work.

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

## E2E validation tiers

Load `use-e2e` for test selection and diagnostics, and load `e2e-validation` for the ordered validation procedure.

- `src/test/e2e/work/` is the required continuous gate: one 120-second smoke project plus four single-file, single-top-level-test daily workflows with 600-second hard timeouts. Run the complete local gate with `npm run test:e2e:work`.
- `src/test/e2e/functional/` holds stable focused black-box regressions. Run only the files or test names required by the changed behavior; full functional execution is reserved for nightly or explicit investigation.
- `src/test/e2e/dev/` holds fault injection, forensic capture, and narrowly scoped reproduction. It uses one worker, no retries, and retained failure traces, and it never enters required CI or release gates.
- `playwright.pressure.config.ts` remains the explicit pressure/soak tier. Do not use it as routine completion evidence.
- Keep `demo/`, `fixtures/`, and `utils/` in their existing roles. Work journeys must not duplicate functional implementation geometry or state matrices.
- Every E2E process uses a unique `DLINE_E2E_RUN_ID`. Preserve failed artifacts and diagnose the first unmet boundary before increasing a timeout or broadening scope.

### Never hand-roll a tsc invocation

Type checking is `npm run check-types`. It already covers the root project and `webview-ui/tsconfig.app.json`; there is no reason to assemble a tsc command by hand.

Two failure modes have repeatedly scattered thousands of `.js`/`.js.map` files through `src/`:

- `tsc -b` is the project-references **build** mode. It is meant to emit. Use `--noEmit` to check.
- `npm --prefix <dir>` only changes where npm resolves `package.json` and `node_modules`; it does **not** change the process working directory. `npm --prefix webview-ui exec -- tsc -b` therefore runs tsc against the **root** config.

The root `tsconfig.json` now sets `noEmit: true` specifically to make that mistake inert, because `rootDir` is the repo root and there is no `outDir`. Scripts that genuinely need output pass `--noEmit false` explicitly: `scripts/build-tests.js` and the `watch-tests` script. Keep that opt-in; do not remove the guard to make a one-off command work.

To scope a check to another project, pass `-p <path>` from the repo root rather than trying to change directories. When a command must run elsewhere, use the tool's `workdirectory` parameter.

Production bundling is esbuild (`npm run package` → `esbuild.mjs --production`), not tsc, so it is unaffected.

## Protobuf and ProtoBus

Follow `protobuf-development` for protocol changes.

Proto files use the `dline` namespace and live under `proto/dline/`. `npm run protos` regenerates shared types, grpc-js/nice-grpc bindings, host glue, the Webview ProtoBus client, and the descriptor set. Never edit generated output as the source change.

A new RPC normally requires the proto service method, regenerated output, a backend/host handler, a generated client call, and transport/handler tests.

## Providers and ModelRegistry

When adding or materially changing a provider:

1. inspect `src/core/api/index.ts` and a current analogous handler;
2. update the provider/profile proto and conversion boundaries that actually carry the configuration;
3. keep runtime model metadata in `ModelRegistry` seed/remote policy rather than a deleted static provider JSON catalog;
4. update settings normalization, validation, and provider UI only where the provider contract requires it;
5. set the correct `ApiFormat` and server-tool capabilities in model metadata;
6. use proxy-aware and observed transports from `@shared/net`;
7. test configuration round-trip, handler selection, model reconciliation, native/XML tools, cancellation, and sanitized failures.

Responses API support is driven by API format and provider capabilities. Do not add an `isNextGenModelProvider()` branch or model-family prompt variant.

## Prompt and tool changes

The only stable prompt profiles are Standard and Lite. Tool descriptions have one canonical source in `src/core/prompts/tools/tool-specs.ts`, with ordered inclusion in `tool-ids.ts`. Native and XML definitions are projected from that source.

Do not create `system-prompt/tools/<tool>.ts` model-family variants or edit generated provider schemas independently.

For a new tool, load `add-new-tool`. The change may include:

- `ClineDefaultTool` and read-only classification;
- i18n prompt module registration;
- canonical descriptor and Standard/Lite membership;
- handler and executor coordination;
- host bridge only for IDE-native capabilities;
- grouped, say/ask, or backend-owned presentation;
- approval, turn-ending, native/XML, cancellation, and recovery tests.

## Capabilities metadata

Skills and workflows are advertised from YAML frontmatter. Every workflow file must include:

```yaml
---
name: stable-workflow-name
description: One concise sentence explaining when and why to load it.
---
```

The workflow parser falls back to the file name for a missing name, but missing descriptions produce empty or fallback catalog text. Treat both fields as required. Skill names must match their directory names.

## State and storage keys

Follow `storage` before adding persistent state.

- Add keys to the correct category in `src/shared/storage/state-keys.ts`.
- Access runtime state through `StateManager` or the owning repository, never directly through VS Code `ExtensionContext`.
- Settings, global state, workspace settings/state, secrets, and task settings have different persistence and consistency boundaries.
- User-toggleable state must round-trip through the relevant proto/controller/Webview or CLI surface.
- Startup migrations may read legacy VS Code storage, but new runtime behavior must not make it authoritative again.

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

Load `writing-documentation` for documentation work.

## Git and release work

Follow `repository-and-release`. Reusable instructions must not hard-code a remote alias, repository owner, or URL. Ordinary PRs come from independent branches into `dev`; only an integrated and verified `dev` candidate may be promoted to `main` and tagged for production.
