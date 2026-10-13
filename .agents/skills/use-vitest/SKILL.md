---
name: use-vitest
description: Run, rerun, inspect, and diagnose Dline Vitest tests with bounded focused commands or a repository-identified background Vitest UI server, without treating unknown collection state as success.
---

# Use Vitest

Use bounded one-shot processes for focused tests. When the user requests all Vitest tests or all configured projects, use the background Vitest UI workflow so the long-lived server is detached from the execution turn and all results are read through the repository wrapper.

## Execution Safety Boundary

Never start Vitest UI or a Vitest watch process for a focused test unless the user explicitly requests UI/watch startup. A request to run all Vitest tests, the full suite, or all configured projects is explicit authorization to automatically start or reuse the background Vitest UI server.

Do not run these commands by default:

```text
npx vitest --ui
vitest --ui
npm run test:watch
npm --prefix webview-ui run test:watch
vitest
```

`vitest` without `run` starts watch mode, and the Webview `test:watch` script is `vitest dev`. `npm run watch-tests` is not Vitest at all: it is a `tsc` watch that emits into `out/`; do not use it for test validation either.

- `npm run vitest:ui:server` starts the long-lived repository-local server for CLI use;
- `npm run vitest:ui:mcp` uses `ensureVitestUiServer()` to reuse the configured endpoint or start the repository-local Vitest 4 process automatically.

When starting the CLI server through `execute_command`, use `background=true` and `timeout=0`. Record the returned `function_id`, repository root, config, and URL. Keep a healthy server running after the test task completes unless the user asks to stop it or it must be replaced because it is unhealthy.

A reachable URL alone does not prove that the server belongs to the current checkout. Managed startup reads the Vitest UI RPC config, compares its repository root with the current checkout, and rejects cross-checkout reuse. Status and rerun results expose the resolved identity; record and verify it before trusting results.

### Background Server Cancellation

Dline exposes different Cancel controls with intentionally different ownership semantics:

- The running command card's **Cancel** button in the Work view cancels the exact command activity by `activityId`; it will terminate the Vitest UI server.
- The matching **Cancel** button in the Activities view uses the same exact activity cancellation and will also terminate the server.
- The task footer's **Cancel** button pauses the foreground Task and cancels only Task-owned work. It does not terminate a server started with `background=true`, because that command has explicit cancellation ownership.
- `kill_command` with the server's exact `function_id` explicitly terminates that one server without cancelling the Task or other commands.
- Closing or destroying the Task performs full cleanup and can terminate all commands associated with that Task, including explicit background work.

When reporting the resident server, identify its `function_id`, URL, and the distinction above. Do not claim that every Work-view Cancel preserves the server: the command card's own Cancel is an explicit process cancellation, while the task footer Cancel is not.

## Confirm The Contract

Treat these files as the source of truth if commands appear stale:

- `package.json`: npm script names and lifecycle hooks.
- `vitest.config.ts`: the root project list only (backend projects plus the Webview project).
- `vitest.backend-projects.ts`: backend project names and path ownership, path aliases, the `threads` pool with `maxWorkers: 4`, the shared setup file, the `src/test/e2e/**` exclusion, and the 60-second `testTimeout`.
- `vitest.smoke.config.ts`: the `backend-smoke` project used by `npm run test:smoke`.
- `webview-ui/vitest.project.ts`: Webview test root, jsdom, setup file, include globs, aliases, workers, and timeout; `webview-ui/vitest.config.ts` adds the React plugin.
- `scripts/vitest-ui/cli.mjs`: supported commands and flags (`status`, `errors`, `files`, `rerun all|failed|file|test|task`).
- `scripts/vitest-ui/lib/client.mjs`: the default URL and the rejection of empty, incomplete, or `unknown` collections.
- `scripts/vitest-ui/server.mjs`: direct background server startup.
- `scripts/vitest-ui/lib/managed-server.mjs`: MCP reuse/start behavior and configured endpoint selection.

Do not infer a command from memory when one of these files has changed.

## Run One-Shot Tests

Prefer `test:run`. It expands to `vitest run` and does not invoke the `pretest` lifecycle hook. `test:unit` is the same run with an explicit `--config vitest.config.ts`.

Other one-shot scripts:

- `npm run test:smoke`: the `backend-smoke` project (`src/__tests__/smoke.test.ts`).
- `npm run test:perf`: `src/core/task/performance` with `DLINE_PERF_GATES=1`; without that variable the absolute timing gates are skipped.
- `npm run test:webview`: the Webview package's `vitest run`.

Escalate test scope deliberately:

1. Reproduce and diagnose with one named test or one test file whenever possible.
2. After the fix, rerun the original focused scope first.
3. Then run the owning Vitest project when the changed boundary warrants broader confidence.
4. When the user requests all projects, switch to the background Vitest UI workflow instead of launching a foreground one-shot full run.

A full Dline rerun normally takes about 7-10 minutes. Give Vitest UI CLI wait/rerun operations a timeout of at least 15 minutes, keep querying the same server, and do not start another server or full run because output is temporarily quiet. Prefer separate one-shot project runs for local changes; reserve the UI workflow for explicit full-suite validation.

Run focused root tests:

```
npm run test:run -- src/core/task/tools/handlers/__tests__/SpawnTaskHandler.test.ts
```

Run several related files:

```
npm run test:run -- src/core/api/providers/__tests__/openai.test.ts src/core/api/providers/__tests__/deepseek.test.ts
```

Run one test by name:

```
npm run test:run -- src/core/task/tools/handlers/__tests__/SpawnTaskHandler.test.ts -t "should return toolError"
```

Select a root project when running a broad pattern or resolving ambiguous ownership:

```
npm run test:run -- --project backend-task src/core/task
```

Run Webview tests from the Webview package so paths are relative to `webview-ui`:

```
npm --prefix webview-ui test -- src/components/settings/OpenAIServiceTierSelector.test.tsx
```

For all configured root projects, do not run a foreground `npm run test:run`. Follow the background Vitest UI workflow below so the server survives command handoffs and the repository CLI provides the durable result channel.

Do not use `npm test` for routine focused validation. Its `pretest` hook runs `npm run protos`, which can regenerate and format files before the tests. Use it only when that lifecycle behavior is intentionally required.

## Regenerate Prompt Snapshots

Any intentional change to prompt prose, prompt templates, prompt assembly, profile projection, or other generated system-prompt output MUST regenerate the repository-owned prompt snapshots before prompt validation is considered complete.

Use the dedicated package script from the repository root:

```
npm run test:snapshot
```

Treat `package.json` as the source of truth for the exact generation scope. The script sets the required snapshot-update environment variables and runs the repository's prompt and focus-chain snapshot generators. Do not replace it with an ad hoc Vitest command, and NEVER hand-edit generated `.snap` files.

After generation succeeds, review the resulting snapshot changes and run the owning tests without update flags. The script also regenerates the focus-chain snapshot, which belongs to `backend-task`, so run both:

```
npm run test:run -- --project backend-prompts
npm run test:run -- src/core/task/focus-chain/__tests__/prompts-snapshot.test.ts
```

Snapshot generation passing proves that the generator completed; the subsequent project run verifies that the committed baselines and the rest of the prompt tests are consistent. Report separately any unrelated pre-existing failures rather than modifying their assertions or inventories to make the suite pass.

## Select The Project

`vitest.backend-projects.ts` and the Webview config assign tests by path:

| Project | Owned tests |
| --- | --- |
| `backend-task` | `src/core/task/**/*.test.ts` |
| `backend-prompts` | `src/core/prompts/**/*.test.ts` |
| `backend-hooks` | `src/core/hooks/**/*.test.ts` |
| `backend-core` | Other `src/core/**/*.test.ts` files |
| `backend` | Tests under `src/` outside `src/core/` |
| `webview` | Tests/specs under `webview-ui/src/` |
| `backend-smoke` | `src/__tests__/smoke.test.ts`, only through `vitest.smoke.config.ts` (`npm run test:smoke`) |

`src/test/e2e/**` is excluded from every backend project; those files are Playwright tests (see `use-e2e`).

CI (`.github/workflows/test.yml`) runs `npm run test:smoke`, then each project separately with `npx vitest run --config <config> --project <name>`. Reproduce a CI project failure with the same project selector locally.

Start with the changed module's focused test. Then run adjacent tests for shared contracts, and broaden only in proportion to the change's blast radius.

When broader validation is appropriate, run the owning project before considering all projects. Do not use a full rerun merely to validate a local test or fixture change.

## Run Or Reuse The Background Vitest UI

The CLI in `scripts/vitest-ui/cli.mjs` only connects to an existing server; it does not start one. For an explicit full-suite request, first reuse a healthy server or automatically start one in the background.

Probe at most five consecutive ports, from `51205` through `51209`. A 2xx response proves reachability only. Stop at the first endpoint whose Vitest UI identity reports the current repository root and config; managed startup rejects a reachable endpoint owned by another checkout and requires a dedicated port or URL. The CLI honours `VITEST_UI_URL`; the server and MCP wrapper honour `VITEST_UI_HOST`, `VITEST_UI_PORT`, and `VITEST_UI_CONFIG`.

Each candidate URL has the form `http://localhost:<port>/__vitest__/`. Use a short per-probe timeout. Pass the selected URL through `--url` on every subsequent CLI command; do not keep assuming port `51205` after another port is selected.

If all five probes fail during a full-suite request, start the server automatically on the first candidate port with `execute_command`:

```text
command: npm run vitest:ui:server -- --host localhost --port 51205 --config vitest.config.ts
workdirectory: <repository-root>
background: true
timeout: 0
requires_approval: false
```

The server wrapper supplies `--watch --no-open` to Vitest, so it remains resident without launching a system browser. Record the returned `function_id` and candidate URL. Because the server was started with `background=true` and `timeout=0`, do not wait for that command to exit. The wrapper waits up to 60 seconds for the UI to start and then dispatches the initial run; if the command output shows `[vitest-ui] failed to bootstrap initial run`, the wrapper has already shut the server down, so report that output. If the background command exits or the port is occupied by a non-Vitest service, inspect the command result and try the next candidate port, stopping after `51209`. Do not start duplicate servers on ports that already expose a healthy Vitest UI.

If no candidate can start, report the environment/startup failure and do not claim that the full suite ran. Do not silently replace the requested UI workflow with a foreground full run.

A newly started UI automatically begins its initial full run. Do not poll a non-waiting `status`: it exits non-zero while the collection is empty, incomplete, or contains `unknown` files. Go straight to the waiting status, which blocks until the collection is non-empty, complete, idle, and free of `unknown` files:

```
npm run vitest:ui -- status --url <vitest-ui-url> --wait-idle --timeout 900000 --rpc-timeout 900000
```

For a reused UI server, first wait for any active run to become idle, then explicitly rerun all collected files so the result reflects the current workspace:

```
npm run vitest:ui -- rerun all --url <vitest-ui-url> --wait --allow-unknown=false --timeout 900000 --rpc-timeout 900000
```

Persistent `unknown` files are not passing files. Both CLI and MCP waited reruns default to rejecting unknown placeholders. Keep the explicit `--allow-unknown=false` flag in verification commands for readability. Use `--allow-unknown=true` only for diagnostic work where the user accepts an incomplete collection result, and never report that result as passing.

Read current failures:

```
npm run vitest:ui -- errors --json --timeout 10000 --rpc-timeout 15000
```

Add `--url <discovered-url>` to each Vitest UI CLI command when the reachable server is not at the default URL.

Read status without waiting:

```
npm run vitest:ui -- status --filter fail --details --timeout 10000 --rpc-timeout 15000
```

Wait for an existing focused rerun to become idle when waiting is part of the request:

```
npm run vitest:ui -- status --wait-idle --timeout 180000 --rpc-timeout 180000
```

Rerun failures on the existing server:

```
npm run vitest:ui -- rerun failed --wait --allow-unknown=false --timeout 180000 --rpc-timeout 180000
```

Rerun one file or test:

```
npm run vitest:ui -- rerun file --file src/core/foo.test.ts --wait --allow-unknown=false --timeout 180000 --rpc-timeout 180000
npm run vitest:ui -- rerun test --file src/core/foo.test.ts --test "does the thing" --wait --allow-unknown=false --timeout 180000 --rpc-timeout 180000
```

Use `--all-matches` only after confirming that rerunning every match is intended. Use `--allow-unknown=true` only to tolerate uncollected placeholder files for diagnostics; verification commands must use `--allow-unknown=false`, and unknown files must never be counted as passing.

## Waiting For The Full Suite

A full run takes roughly 7-10 minutes on the background server. Collect the result with a single bounded wait rather than repeated short status probes:

```
npm run vitest:ui -- status --url <vitest-ui-url> --wait-idle --timeout 900000 --rpc-timeout 900000
```

If the remaining plan already contains work that does not touch the files being executed, that work may proceed during the wait; documentation, memory-bank updates, and separate E2E or fixture work are typical examples. This is an option, not an obligation: when nothing else is planned, simply wait for the run. Never invent extra work to fill the interval.

Do not edit production source while the suite is executing it. A mid-run edit makes the reported result describe a tree that no longer exists, so the run has to be repeated.

## Handle Running Commands

When a bounded one-shot or CLI command yields a continuation/process handle, keep collecting it until exit. Wait in intervals of at most 30 seconds, send concise progress updates, and do not start duplicate test runs because output is temporarily quiet. The background Vitest UI server is the exception: verify it through its URL and retained `function_id`, but leave the healthy long-lived process running rather than waiting for it to exit.

If a one-shot test exceeds its expected duration, inspect the active process and the test's awaited boundary. Do not switch to watch/UI mode to obtain output.

Both the backend projects (`vitest.backend-projects.ts`) and the Webview project (`webview-ui/vitest.project.ts`) set `testTimeout: 60_000`. A failure at approximately 60 seconds usually indicates an unresolved promise, import, timer, interaction, or worker boundary. Diagnose that boundary; do not raise the timeout merely to make the test pass.

## Report Results

Always report:

- The exact command scope or test files.
- For a full run, the Vitest UI URL, whether it was started or reused, and the CLI command used to obtain the result.
- Test files passed/failed and tests passed/failed; never count `unknown` files as passing.
- The first meaningful assertion, stack, or timeout boundary.
- Whether a failure came from test behavior, collection, or command/environment startup.
- Any validation that could not be run.

After a fix, rerun the original RED test first. Then run adjacent tests and static checks appropriate to the changed production boundary.
