---
name: use-e2e
description: Use when running or diagnosing Dline Playwright E2E tests, especially VS Code UI failures, timeouts, screenshots, missing profiles, mock queue exhaustion, flaky parallel tasks, or artifacts under tmp/test-result.
---

# Use E2E

## Overview

Dline E2E tests use Playwright to launch a real VS Code instance, load the extension, and verify observable behavior through a mock API. E2E tests are appropriate for Webview and host-bridge integration, Task lifecycle, tool calls, persisted configuration, screenshot layouts, and cross-process state. Prefer Webview/Vitest or backend tests for pure React rendering or backend-only logic.

## When to Use

Use this skill when:

- You need to verify real VS Code, Webview, Electron, or extension-host interaction.
- Vitest passes, but a real Task, API request, tool result, or layout is still incorrect.
- You need to reproduce `API Request Failed`, profile-unavailable errors, mock queue exhaustion, VS Code startup failures, or test timeouts.
- You need to inspect screenshots, Dline Output logs, VS Code logs, or Task state.
- Parallel E2E processes cause missing profiles, state leakage, port conflicts, or overwritten artifacts.

Do not launch full VS Code merely to verify a pure function, one React class name, or one RPC handler. Choose the smallest useful test layer first.

## Core Commands

Run commands from the repository root and collect them until the process exits.

| Purpose | Command |
| --- | --- |
| Run the complete required gate | `npm run test:e2e:work` |
| Run only the work smoke | `npm run test:e2e:work -- --project "work smoke"` |
| Run one daily workflow with its smoke dependency | `npm run test:e2e:work -- --project "work chat tools"` |
| Run one functional file | `npm run test:e2e:functional -- src/test/e2e/functional/<domain>/<file>.test.ts --project "functional e2e tests" --workers=1 --retries=0` |
| Run one development diagnostic | `npm run e2e:dev -- src/test/e2e/dev/bug-<behavior>.test.ts --project "development e2e tests" --workers=1 --retries=0` |
| Run the explicit packaged pressure tier | `npm run test:e2e:pressure` |
| Run one demo/capture file | `npm run e2e:demo -- src/test/e2e/demo/<file>.demo.ts` |
| Inspect who currently owns `dist/` | `npm run e2e:lock:status` |
| List a tier without launching VS Code | `npx playwright test -c <playwright-tier-config> <path> --list` |

### Source mode versus packaged mode

The extension source a tier loads is decided by `PACKAGED_E2E_LIFECYCLES` in `src/test/e2e/utils/vscode-launch-isolation.ts`, not by the script name:

- **Packaged mode** (`test:e2e`, `test:e2e:optimal`, `test:e2e:pressure`): builds `dist/e2e.vsix` and installs it per worker slot. `vsce package` runs `vscode:prepublish`, so `dist/extension.js` becomes a production bundle.
- **Source mode** (`e2e:*`, `test:e2e:work`, `test:e2e:functional`): the `pree2e` hook builds generated code, the Webview, and a dev bundle, then VS Code loads the checkout through `--extensionDevelopmentPath`.

`test:e2e:work` and `test:e2e:functional` are source mode with the VS Code and Playwright download step added; they deliberately do not package a VSIX their fixture would never install. Set `DLINE_E2E_INSTALL_VSIX=1` to force packaged mode when a current `dist/e2e.vsix` already exists.

Raw `npx playwright test` intentionally skips npm lifecycle hooks and the `dist/` lock; use it only when the artifact is already current.

Start with one test file, one project, or one test name. Broaden only when the change crosses multiple stable contracts. Do not use `--debug`, `--headed`, retries, or a longer timeout as a substitute for one-shot evidence.

### The dist/ build lock

Every E2E resource is run-scoped through `DLINE_E2E_RUN_ID` except `dist/`, which has a fixed path. `scripts/with-dist-lock.mjs` therefore guards it with a reader/writer lock under `dist/.e2e-lock/`: builds take the exclusive side and Playwright runs take the shared side.

This means:

- One build at a time. A second build is refused while a build or any test run owns `dist/`.
- Several test runs may share one prepared build concurrently.
- A build is refused while test runs are still reading, because rebuilding would swap the bundle underneath them.

To run tiers concurrently, prepare once and then start read-only runs:

```powershell
npm run test:e2e:build          # or: npm run pree2e
$env:DLINE_E2E_RUN_ID = "concurrent-a"; npx playwright test -c playwright.work.config.ts
```

When a command is refused, the error names the holding PID, run ID, and command. Run `npm run e2e:lock:status` to inspect holders; entries left by a crashed run are pruned automatically on the next attempt, so never delete `dist/.e2e-lock/` while another run is active.

## Test Domains

- **Work gate**: `playwright.work.config.ts` and `src/test/e2e/work/`. It contains one 120-second smoke and four 600-second single-file, single-top-level-test daily workflows. This is the required CI and release E2E surface.
- **Functional regressions**: `playwright.functional.config.ts` and `src/test/e2e/functional/`. Keep tests focused, stable, and black-box; run only affected files or names during implementation. Full functional execution is nightly or explicitly requested.
- **Development diagnostics**: `playwright.dev.config.ts` and `src/test/e2e/dev/`. Use readable `bug-`, `feature-`, or `issue-<number>-` names for fault injection, forensic capture, and precise reproduction. Dev uses one worker, no retries, retained failure traces, and never enters required CI.
- **Pressure**: `playwright.pressure.config.ts` is the explicit load/soak tier, not routine completion evidence.
- **Default compatibility collection**: `playwright.config.ts` collects ordinary work and functional tests while excluding dev. Do not run it as the normal required gate.
- **Demo/capture E2E**: `playwright.demo.config.ts` and `src/test/e2e/demo/**/*.demo.ts` are for deterministic media or scenario capture, not regression evidence.
- **Legacy E2E**: `playwright.legacy.config.ts` is only for explicitly retained compatibility scenarios.
- **Storybook**: stories live under `webview-ui/src/**/*.stories.tsx`. Use `npm run storybook` for interactive inspection or `npm --prefix webview-ui run build-storybook` for a bounded static build.

## Pre-Run Checks

1. Read `package.json`, the selected tier config, and `src/test/e2e/work/manifest.ts` when work projects are involved. Do not infer commands, lifecycle hooks, project names, or timeouts.
2. Choose work, functional, dev, pressure, demo, legacy, or Storybook based on the behavior being proved. Do not report one tier as coverage for another.
3. Set a unique run ID for every Playwright process:

```powershell
$env:DLINE_E2E_RUN_ID = "functional-task-resume-20260917"
npm run test:e2e:functional -- src/test/e2e/functional/tasks/history-resume-liveness.test.ts --project "functional e2e tests" --workers=1 --retries=0
```

`DLINE_E2E_RUN_ID` may contain only letters, numbers, dots, underscores, and hyphens. If it is not set, the fixture creates a process-unique ID.

4. Do not manually delete the entire `tmp/test-result` directory or temporary directories owned by another run. Global setup cleans only its own run namespace; deleting external directories can cause trace `ENOENT` errors or remove another Task's profile.
5. Required CI packages one VSIX, then runs work smoke and the four daily projects on Linux, macOS, and Windows against that same artifact. Full functional and dev runs are not substitutes for this gate.

## Artifact Locations and Isolation

Playwright artifacts are stored at:

```text
tmp/test-result/<run-id>/
├── <test-result-directory>/
│   ├── trace.zip
│   ├── test-failed-1.png
│   ├── vscode-failure.png
│   ├── dline-output.log
│   ├── vscode-logs/
│   └── dline-task-state/
└── .last-run.json
```

Dline runtime data uses a finer isolation hierarchy:

```text
System temp/.dline-e2e/<run-id>/worker-<index>/test-<test-id>-retry-<n>/...
System temp/dline-e2e/<run-id>/worker-<index>/test-<test-id>-retry-<n>/...
```

- **Run ID** isolates separate Playwright processes.
- **Worker index** isolates workers within one run.
- **Test ID + retry** isolates each Task test and retry.
- The mock server uses a dynamic loopback port; each test calls `resetOpenAiMock()` to clear response queues and consumptions.
- Do not assume identical test titles share an artifact directory; recording paths must include test identity and retry.

`dist/` is the deliberate exception: it is a fixed path shared by every tier, which is why it is serialized by the build lock rather than namespaced. Treat it as a single shared artifact, not as run-scoped state.

If two independent E2E processes still interfere while both start at `worker-0`, first check whether `DLINE_E2E_RUN_ID` was reused and whether code is cleaning a fixed root outside the current run namespace. If the symptom instead looks like the wrong extension build - a production bundle in a dev run, an assertion failing against code that is not in the checkout - check `npm run e2e:lock:status` and whether a concurrent build rewrote `dist/`.

## Writing E2E Tests

### Use the Project Fixture

Real VS Code tests use `e2e`, not the base `test` fixture:

```typescript
import { expect } from "@playwright/test"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"

e2e("Task renders the completed result", async ({ helper, sidebar, server, userDataDir }) => {
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{ type: "message", text: "E2E_RESULT_OK" },
	)

	const input = sidebar.getByTestId("chat-input")
	await input.fill("Run the E2E task")
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText("E2E_RESULT_OK", { exact: false })).toBeVisible({ timeout: 60_000 })
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
```

### Interaction and Waiting

- Prefer `getByTestId`, `getByRole`, `getByLabel`, and observable text.
- Wait for every asynchronous boundary using observable results: a button becomes visible, input becomes enabled, completion text appears, or request count reaches the expected value.
- Do not use a short fixed `waitForTimeout` to prove that business behavior completed. If startup or streaming stabilization truly requires a delay, explain why and use `expect.poll` or a state assertion.
- Verify real inputs, outputs, tool results, and request contracts rather than only checking that a mock function was called.
- Assert only stable, product-relevant layout properties such as `max-height: 80vh`, `overflow-y`, and `scrollHeight > clientHeight`.

### Mock Response Queues

Reset the queue at the start of each test and enqueue only the responses that test needs:

```typescript
server.resetOpenAiMock()
server.enqueueOpenAiResponses(
	{ type: "tool", id: "call_read", name: "read_file", arguments: { path: "README.md" } },
	{
		type: "tool",
		id: "call_done",
		name: "attempt_completion",
		arguments: { result: "E2E_DONE" },
		expectedToolResults: [{ callId: "call_read", contentIncludes: "# Test Workspace" }],
	},
)
```

After the test, inspect `server.getMockConsumptions(...)`:

- `responseType` and `toolName` appear in the expected order.
- `contractError` is undefined.
- `requestToolResults` contains the real tool result.
- Do not use an oversized shared queue that lets neighboring Tasks pass by coincidence.

## Failure-Diagnosis Order

When a test fails, do not immediately change production code. Preserve the failed run's `DLINE_E2E_RUN_ID` and full command, then inspect evidence in this order:

1. **The first Playwright assertion or timeout boundary**
   - Distinguish startup, fixture, UI locator, API-contract, and business-assertion failures.
   - A timeout near 60 seconds usually indicates an unresolved Promise, streaming state, Electron startup, or fixture-scope problem.
2. **Screenshots**
   - Inspect `tmp/test-result/<run-id>/<test-result-directory>/test-failed-1.png`.
   - For a real VS Code page failure, also inspect `vscode-failure.png`.
   - Use screenshots to determine whether the page is stuck on Welcome, profile unavailable, API Request Failed, approval, a blank Webview, or another error state. Do not infer the UI state from the exception text alone.
3. **Dline output log**
   - Inspect `dline-output.log`, captured automatically by the `userDataDir` fixture on failure.
   - Search for `[error]`, `uncaught`, `unhandled`, `TypeError`, `ReferenceError`, `invalid_runtime_event`, profile rebuild, API request, and mock queue messages.
   - Use `E2ETestHelper.expectNoUnexpectedDlineErrors` as an aid, but do not blanket-suppress diagnostics that have not been understood.
4. **VS Code logs**
   - Inspect the newest files under `vscode-logs/` to determine whether the extension host, Webview, Electron, or CDP exited early.
   - If the page closed, a screenshot may not exist; logs and the Playwright trace become the primary evidence.
5. **Task state**
   - Inspect `dline-task-state/` to determine whether the Task was created, the profile was written, an interaction or operation is stuck, or data was written to the wrong directory.
6. **Mock consumption and request body**
   - Inspect the first `contractError`, request count, provider/protocol/path, tool results, and response order in `getMockConsumptions()`.
   - For `Profile not found`, provider unavailable, or queue exhaustion, investigate fixture and directory isolation before attributing the failure to UI business logic.
7. **Trace**
   - For a complete action timeline, run with `--trace=on` and inspect actions, DOM snapshots, network, and console in the Playwright trace viewer.
   - Do not let global setup delete `outputDir` during a trace run; otherwise `.playwright-artifacts/*.zip` can fail with `ENOENT`.

### Symptom-to-Evidence Map

| Symptom | First evidence to inspect |
| --- | --- |
| `Profile ... not found` / provider unavailable | Run ID, Dline profile file, Task state, and setup/teardown directory cleanup |
| `e2e_mock_queue_exhausted` | Mock consumption order, response count, and unexpected retry requests |
| `e2e_tool_result_contract_failed` | Previous tool result, call ID, request body, and `expectedToolResults` |
| `API Request Failed` | Screenshot, Dline log, provider/protocol/path, and response status |
| Blank page or sidebar frame unavailable | `vscode-failure.png`, VS Code logs, console/pageerror, and Webview-frame initialization |
| `ENOENT .playwright-artifacts/*.zip` | Whether setup deleted the current run's output root |
| Tasks interfere with each other | `DLINE_E2E_RUN_ID`, worker/test/retry directories, dynamic ports, and mock queue reset |
| 60-second timeout | The first unmet wait boundary; do not increase the timeout first |

## Minimal Reproduction After a Failure

1. Preserve the failed run's artifacts; do not clean the directory.
2. Rerun one test with the same `DLINE_E2E_RUN_ID` to confirm reproducibility. Use a new run ID if the old artifacts must remain untouched.
3. Use `--workers=1 --retries=0` to remove parallel and retry noise, but do not treat this as the final isolation fix.
4. If one worker passes while parallel execution fails, run the isolation-contract test and inspect directory naming instead of changing business logic.
5. After a fix, rerun the original failing test first, then adjacent protocol/fixture tests, and only then consider a broader regression run.

## Completion Criteria

Before declaring an E2E change complete, record:

- The exact command, files, and test counts that ran.
- The first meaningful assertion or log evidence from the failure or success.
- Whether failure screenshots, Dline logs, VS Code logs, and Task state were available.
- Whether parallel isolation, mock queues, and retry behavior were verified.
- Which Electron E2E, build, or type checks were not run, with the reason.

Do not report “Playwright listed the tests” as “the feature passed”; `--list` proves only that the configuration parses, not that VS Code behavior works.
