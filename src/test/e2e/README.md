# E2E Tests

This directory contains Playwright end-to-end tests that exercise Dline inside a real VS Code Electron host.

## Test Tiers

Regular product tests do not live at the `src/test/e2e/` root. Place each scenario in the tier that owns its purpose:

- **`work/`** - A bounded smoke test and continuous daily user journeys. `playwright.work.config.ts` caps smoke at 60 seconds and each daily journey at 10 minutes.
- **`functional/`** - Stable, focused black-box regressions for one feature or contract. These tests should prefer visible controls, settings, inputs, outputs, and the minimum required Mock Provider contract.
- **`dev/`** - Development-only diagnosis, fault injection, and precise regression capture. Use `bug-<behavior>.test.ts`, `feature-<behavior>.test.ts`, or `issue-<number>-<behavior>.test.ts`.
- **`demo/`** - Marketplace recording scenarios, isolated from normal product gates.
- **`fixtures/`** - Synthetic workspaces and Mock Provider fixtures.
- **`utils/`** - Shared setup, worker/test isolation, VS Code launch, and UI helpers.

Use the `@e2e/*` TypeScript alias for imports from `utils/` and `fixtures/`. Product-source imports should use the existing `@core/*`, `@shared/*`, and other project aliases instead of directory-depth-relative paths.

## Running Tests

The tier scripts build the extension and Webview through their `pre*` hooks before Playwright starts:

```bash
npm run e2e:smoke
npm run e2e:work
npm run e2e:functional -- functional/api/api-runtime-observability.test.ts
npm run e2e:dev -- dev/bug-<behavior>.test.ts
```

Use the packaged variants when the scenario must run against `dist/e2e.vsix`:

```bash
npm run test:e2e:work
npm run test:e2e:functional -- functional/profiles/settings-api-profiles.test.ts
```

For focused debugging, keep the tier configuration and append Playwright options:

```bash
npm run e2e:dev -- dev/bug-<behavior>.test.ts --debug
npm run e2e:functional -- functional/tasks/task-runtime-controls.test.ts --headed
npm run e2e:functional -- --grep "Chat"
```

Do not use the broad legacy runner for routine development when a work or focused functional command proves the changed behavior.

## Demo Recordings

Marketplace demo assets use a separate Playwright configuration and are never included in the default E2E suite or CI jobs.
They reuse the mock API server and worker-isolated temporary Dline state, so they must not read local credentials, task history,
or a developer's real workspace.

Build and run one or more demo scenarios:

```bash
npm run e2e:demo -- smoke
npm run e2e:demo -- --grep "R1|R2"
```

Convert registered WebM recordings to GIF assets:

```bash
npm run demo:media -- --id r1-hero
npm run demo:media -- --id smoke --out-dir tmp/demo-media
```

Set `DLINE_DEMO_FFMPEG` when the Playwright-managed ffmpeg executable is stored in a non-standard location. Generated marketplace
GIFs must be at most 20 seconds and 3 MB; PNG screenshots must be 1200 px wide and at most 500 KB. Before accepting an asset,
verify that the frame contains no real API key, username, or personal absolute path.

## Writing Tests

### Basic Test Structure

Use the `e2e` fixture for single-root workspace tests:

```typescript
import { expect } from "@playwright/test"
import { e2e } from "@e2e/utils/helpers"

e2e("Test description", async ({ sidebar, helper }) => {
  await helper.signin(sidebar)

  const inputbox = sidebar.getByTestId("chat-input")
  await inputbox.fill("Hello, Dline!")
  await sidebar.getByTestId("send-button").click()

  await expect(sidebar.getByText("API Request...")).toBeVisible()
})
```

For tests that must cover both workspace layouts, iterate over `E2E_WORKSPACE_TYPES`:

```typescript
import { E2E_WORKSPACE_TYPES, e2e } from "@e2e/utils/helpers"

E2E_WORKSPACE_TYPES.forEach(({ title, workspaceType }) => {
  e2e.extend({ workspaceType })(title, async ({ sidebar, helper }) => {
    // Test implementation
  })
})
```

### Available Fixtures

The test fixtures provide the following objects:

- **`sidebar`** - Playwright Frame object for the Dline extension's sidebar
- **`helper`** - E2ETestHelper instance with utility methods
- **`page`** - Playwright Page object for the main VS Code window
- **`app`** - ElectronApplication instance for VS Code
- **`server`** - Mock API server for backend testing

### Common Patterns

#### Authentication
```typescript
// Sign in with test API key
await helper.signin(sidebar)
```

#### Chat Interactions
```typescript
const inputbox = sidebar.getByTestId("chat-input")
await inputbox.fill("Your message")
await sidebar.getByTestId("send-button").click()
```

#### Mode Switching
```typescript
const actButton = sidebar.getByRole("switch", { name: "Act" })
const planButton = sidebar.getByRole("switch", { name: "Plan" })
await actButton.click() // Switch to Plan mode
```

#### File Operations
```typescript
// Open file explorer and select code
await openTab(page, "Explorer ")
await page.getByRole("treeitem", { name: "index.html" }).locator("a").click()
await addSelectedCodeToClineWebview(page)
```

#### Settings Navigation
```typescript
await sidebar.getByText("settings").click()
await sidebar.getByTestId("tab-api-config").click()
```

### Using the Recorder with Debug Mode

The `--debug` flag enables Playwright's interactive debugging features:

1. **Start debugging session:**
   ```bash
   npm run test:e2e -- --debug
   ```

2. **Playwright will open:**
   - A VS Code window with the Dline extension loaded
   - Playwright Inspector for step-by-step debugging
   - Browser developer tools for element inspection

3. **Recording interactions:**
   - Use the "Record" button in Playwright Inspector
   - Interact with the VS Code interface
   - Playwright generates test code automatically
   - Copy the generated code into your test files

4. **Debugging existing tests:**
   - Set breakpoints in your test code
   - Use the "Step over" button to execute line by line
   - Inspect element selectors and page state
   - Modify selectors and retry actions

### Test Environment

The test environment includes:

- **VS Code Configuration:**
  - Disabled updates, workspace trust, and welcome screens
  - Extension development mode with Dline loaded
  - Temporary user data and extensions directories

- **Mock API Server:**
  - Binds to an available loopback port for each test
  - Provides mock responses for Dline API calls
  - Supports authentication, chat completions, and user management

- **Test Workspaces:**
  - Single-root workspace with HTML, TypeScript, and README files
  - Multi-root workspace with Python provider examples
  - Configurable through fixtures

### Best Practices

1. **Use semantic selectors:**
   ```typescript
   // Good - uses test IDs
   sidebar.getByTestId("chat-input")
   
   // Good - uses roles and accessible names
   sidebar.getByRole("button", { name: "Send" })
   
   // Avoid - brittle CSS selectors
   sidebar.locator(".chat-input-class")
   ```

2. **Wait for elements:**
   ```typescript
   await expect(sidebar.getByText("Loading...")).toBeVisible()
   await expect(sidebar.getByText("Complete")).toBeVisible()
   ```

3. **Clean up state:**
   ```typescript
   // Use helper functions for common cleanup
   await cleanChatView(page)
   ```

4. **Handle async operations:**
   ```typescript
   // Wait for API responses
   await expect(sidebar.getByText("API Request...")).toBeVisible()
   await expect(sidebar.getByText("Response received")).toBeVisible()
   ```

5. **Test both success and error cases:**
   ```typescript
   // Test successful flow
   await helper.signin(sidebar)
   
   // Test error handling
   await expect(sidebar.getByText("API Request Failed")).toBeVisible()
   ```

### Debugging Tips

- Use `page.pause()` to pause execution and inspect the current state
- Add `console.log()` statements to track test progress
- Use `--headed` flag to see the browser window during test execution
- Check video recordings in `test-results/` for failed tests
- Use browser developer tools to inspect element selectors

### Environment Variables

- `DLINE_E2E_TESTS_VERBOSE=true` - Enable verbose logging
- `CI=true` - Adjusts timeouts and reporting for CI environments
- `GRPC_RECORDER_ENABLED=true` - Enable gRPC recording for debugging
- `DLINE_E2E_PROFILE` - Select `auto`, `mock-openai`, `deepseek`, or `openai-compatible`
- `DLINE_E2E_WORKERS` - Override the default of 2 parallel Playwright workers
- `DLINE_E2E_CDP_PORT` - Set the first CDP port; each worker adds its worker index

Each Playwright worker prepares one reusable state template. Mock tests use only generated mock profiles and never read
`~/.dline/data` or live credential environment variables. `functional/harness/provider-live.test.ts` explicitly enables live preprocessing;
only that mode may copy `secrets/**` and `settings/api_profiles.json`. It never copies `secrets.json`, user settings,
provider registry files, task history, or other user state. Before each test, the selected template is copied to that
worker's `%TEMP%/.dline-e2e/worker-N` `DLINE_DIR`; `DLINE_HOME_DIR` uses the same path and `DLINE_DOCS_DIR` uses
`%TEMP%/dline-e2e/worker-N`. All three worker-owned temporary locations are reset between tests and removed during
worker teardown.

### Persistent Legacy Upgrade Fixture

Run `npm run e2e:legacy` separately from the regular parallel suite. It uses one worker and keeps its synthetic user
state in `tmp/.dline-e2e-legacy` (`DLINE_DIR` and `DLINE_HOME_DIR`) and `tmp/dline-e2e-legacy`
(`DLINE_DOCS_DIR` and workspace). The fixture is seeded only when its marker is absent, then every later run upgrades
and validates the same files in place. Regular E2E setup does not clean these directories.

Both directories are covered by the repository's `tmp` ignore rule. They contain fixed fake credentials and must never
be added to Git. Only the generator, loader, assertions, and Playwright configuration are versioned.

Generated live profiles use `high` reasoning effort. GitHub Actions creates only profiles whose corresponding credential
is configured:

- DeepSeek secret: `DLINE_E2E_DEEPSEEK_API_KEY`; optional vars: `DLINE_E2E_DEEPSEEK_BASE_URL`, `DLINE_E2E_DEEPSEEK_MODEL_ID`
- OpenAI-compatible secret: `DLINE_E2E_OPENAI_COMPATIBLE_API_KEY`; optional vars: `DLINE_E2E_OPENAI_COMPATIBLE_BASE_URL`, `DLINE_E2E_OPENAI_COMPATIBLE_MODEL_ID`

Pull requests and the regular three-platform smoke job use the local mock OpenAI-compatible profile. Live provider tests
run only on trusted push or manual workflow events and are skipped when their credential is absent.

## Required Coverage Matrix

Only tests that launch VS Code and operate the Dline Webview count as product E2E. Preprocessing tests validate the
isolated harness but do not count as product E2E coverage.

### Isolated State And Profiles

- [x] Use worker-owned subdirectories beneath `%TEMP%/.dline-e2e` for `DLINE_DIR` and `DLINE_HOME_DIR`, and beneath
  `%TEMP%/dline-e2e` for `DLINE_DOCS_DIR`.
- [x] Copy only `settings/api_profiles.json` and `secrets/**`; never copy root `secrets.json` or task/user state.
- [x] Remove the isolated state after each worker and test.
- [x] Seed mock, DeepSeek, and OpenAI-compatible profiles with `high` effort when credentials are available.
- [x] Launch VS Code with the isolated state and show the prepared profiles in Settings.

### Settings And Provider Profiles

- [x] Rename a profile through the Webview, verify `api_profiles.json`, reopen VS Code, and verify the renamed profile.
- [x] Modify `providers/deepseek.json` while VS Code is running, observe the new model in the provider selector, select it,
  and verify the selected model ID in `api_profiles.json`.
- [ ] Select every registered provider through the Webview and verify the provider/profile write.
- [ ] Persist each provider's API key through the Webview into `secrets/api_keys.json`, without embedding it in
  `api_profiles.json`.
- [ ] Persist structured Bedrock and SAP credentials into `secrets/provider_secrets.json` and verify them after reopen.
- [ ] Cover OpenAI-compatible custom base URL, model ID, API endpoint, service tier, thinking, prompt cache, context,
  output limit, pricing, custom headers, Azure options, and streaming usage settings.
- [ ] Verify each edited Settings value immediately, on disk, and after reopening VS Code.

### Task And Model Synchronization

- [x] Send a chat message through the Webview and assert the mock API response is rendered.
- [ ] Apply profile context/pricing changes to the active Task immediately.
- [ ] Rename the active Task profile and verify the Task model display follows the stable profile ID.
- [ ] Switch a Task-local profile and verify both the displayed profile and context limit change together.
- [x] Run an optional live minimal turn for a configured DeepSeek or OpenAI-compatible profile.

### Tools, Approval, And Continuation

- [x] Exercise `read_file` with auto-approve and with explicit Approve/Reject interaction.
- [x] Exercise `write_to_file` and `replace_in_file` through real tool calls and verify workspace files.
- [x] Exercise `execute_command` through real approval, verify command output, and verify completion state.
- [x] Cancel a running Task from the Webview and verify the Task can resume from the visible Resume interaction.
- [x] Verify approval, retry, cancel, and resume buttons perform their named action instead of only changing UI state.
