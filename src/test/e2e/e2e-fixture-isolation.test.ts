import * as path from "node:path"
import { expect, test } from "@playwright/test"
import { E2ETestHelper } from "./utils/helpers"
import { E2E_OUTPUT_ROOT, E2E_RUN_ID } from "./utils/run-context"
import {
	createVSCodeExtensionInstallArguments,
	E2E_EXTENSIONS_ROOT,
	resolveWorkerExtensionsSlot,
	shouldPreinstallDlineVsix,
} from "./utils/vscode-launch-isolation"

test("E2E fixture isolates run, worker, task, retry, and artifact directories", () => {
	const workerZero = E2ETestHelper.getWorkerDirectories(0)
	const workerOne = E2ETestHelper.getWorkerDirectories(1)
	const taskA = E2ETestHelper.getTestDirectories(workerZero, "task-a", 0)
	const taskB = E2ETestHelper.getTestDirectories(workerZero, "task-b", 0)
	const taskARetry = E2ETestHelper.getTestDirectories(workerZero, "task-a", 1)

	expect(E2E_OUTPUT_ROOT).toContain(path.join("tmp", "test-result", E2E_RUN_ID))
	expect(E2E_EXTENSIONS_ROOT).toContain(path.join("dline-e2e-extensions", E2E_RUN_ID))
	expect(workerZero.dlineDir).not.toBe(workerOne.dlineDir)
	expect(workerZero.dlineDocsDir).not.toBe(workerOne.dlineDocsDir)
	expect(taskA.dlineDir).not.toBe(taskB.dlineDir)
	expect(taskA.dlineDocsDir).not.toBe(taskARetry.dlineDocsDir)
	expect(E2ETestHelper.getResultsDir("same title", "recordings", "task-a-retry-0")).not.toBe(
		E2ETestHelper.getResultsDir("same title", "recordings", "task-b-retry-0"),
	)
})

test("E2E fixture installs the packaged extension before launching VS Code", () => {
	const extensionsDir = path.join("tmp", "extensions", "worker-0")
	const vsixPath = path.join("dist", "e2e.vsix")

	expect(createVSCodeExtensionInstallArguments(extensionsDir, vsixPath)).toEqual([
		`--extensions-dir=${extensionsDir}`,
		`--user-data-dir=${path.join(extensionsDir, ".install-user-data")}`,
		"--force",
		"--install-extension",
		vsixPath,
	])
})

test("E2E fixture preinstalls the packaged extension only for production-style lifecycles", () => {
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: "test:e2e" })).toBe(true)
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: "test:e2e:optimal" })).toBe(true)
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: "test:e2e:pressure" })).toBe(true)
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: "test:e2e:build" })).toBe(false)
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: "test:e2e:ui" })).toBe(false)
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: "e2e" })).toBe(false)
	expect(shouldPreinstallDlineVsix({ npm_lifecycle_event: undefined })).toBe(false)
})

test("E2E fixture reuses a stable extension slot when Playwright replaces a full-run worker", () => {
	const fullRunEnvironment = { npm_lifecycle_event: "test:e2e" }
	const focusedRunEnvironment = { npm_lifecycle_event: "e2e" }

	expect(resolveWorkerExtensionsSlot(1, 1, fullRunEnvironment)).toBe(1)
	expect(resolveWorkerExtensionsSlot(7, 1, fullRunEnvironment)).toBe(1)
	expect(resolveWorkerExtensionsSlot(7, 1, focusedRunEnvironment)).toBe(7)
})
