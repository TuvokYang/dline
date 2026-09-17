import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

/**
 * Force-unlock regression coverage.
 *
 * The unlock request used to release the lock, re-acquire it and rebuild the
 * historical Task inside one RPC. Re-acquiring writes a new lock file while
 * the caller still treats the unlock as in progress, and the background lock
 * poll could acquire concurrently, so the unlock reported failure and the
 * banner only disappeared once the 30s poll finished the takeover itself.
 *
 * This test drives the real button: after confirming, the banner must go away
 * promptly and the lock file must belong to this window.
 */

const TASK_ID = "e2e-force-unlock-task"
const TASK_TEXT = "E2E_FORCE_UNLOCK_TASK"
const BODY_MARKER = "E2E_FORCE_UNLOCK_PERSISTED_BODY"
const FOREIGN_INSTANCE = "e2e-other-dline-instance"

interface SeededTask {
	readonly lockPath: string
}

/**
 * Seed a history task whose lock is held by a different instance.
 * @param dlineDocsDir Per-test Dline documents directory.
 * @param workspaceDir Workspace the task was initialized in.
 * @returns Paths needed to assert lock ownership after the unlock.
 */
async function seedForeignLockedTask(dlineDocsDir: string, workspaceDir: string): Promise<SeededTask> {
	const tasksDir = path.join(dlineDocsDir, "tasks")
	const taskDir = path.join(tasksDir, TASK_ID)
	await mkdir(taskDir, { recursive: true })
	const baseTimestamp = Date.now() - 30_000
	const historyItem = {
		id: TASK_ID,
		ts: baseTimestamp,
		task: TASK_TEXT,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: workspaceDir,
	}
	const messages = [
		{ ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
		{ ts: baseTimestamp + 1, type: "say", say: "text", text: BODY_MARKER },
	]
	const lockPath = path.join(taskDir, ".lock")
	await Promise.all([
		writeFile(path.join(tasksDir, "taskHistory.jsonl"), `${JSON.stringify(historyItem)}\n`, "utf8"),
		writeFile(
			path.join(taskDir, "ui_messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			"utf8",
		),
		writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
		// A fresh timestamp keeps the lock outside the stale TTL, so the window
		// must stay read-only until the user forces the unlock.
		writeFile(lockPath, JSON.stringify({ held_by: FOREIGN_INSTANCE, locked_at: Date.now(), pid: 4242 }), "utf8"),
	])
	return { lockPath }
}

/**
 * Read the instance address currently recorded in the task lock file.
 * @param lockPath Absolute path of the task's .lock file.
 * @returns The holder address, or "" when the lock is absent or unreadable.
 */
async function readLockHolder(lockPath: string): Promise<string> {
	try {
		const raw = await readFile(lockPath, "utf8")
		const data = JSON.parse(raw) as { held_by?: unknown }
		return typeof data.held_by === "string" ? data.held_by : ""
	} catch {
		return ""
	}
}

e2e(
	"Force unlock releases the foreign lock and hands the task to this window",
	async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const { lockPath } = await seedForeignLockedTask(dlineDocsDir, workspaceDir)
		expect(await readLockHolder(lockPath)).toBe(FOREIGN_INSTANCE)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await page.getByRole("button", { name: "History", exact: true }).click()
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
			await expect(historyTask).toHaveCount(1)
			await historyTask.click()

			// The window opens read-only because another instance holds the lock.
			await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
			const unlockButton = sidebar.getByRole("button", { name: "Unlock", exact: true })
			await expect(unlockButton).toBeVisible({ timeout: 30_000 })
			expect(await readLockHolder(lockPath)).toBe(FOREIGN_INSTANCE)

			await unlockButton.click()
			await expect(sidebar.getByText("Unlock Task", { exact: true })).toBeVisible({ timeout: 10_000 })
			const unlockStartedAtMs = Date.now()
			await sidebar.getByRole("button", { name: "Confirm", exact: true }).click()

			// The banner must clear on the unlock response itself, well inside the
			// 30s poll interval that used to be the only path that recovered.
			await expect(unlockButton).toBeHidden({ timeout: 15_000 })
			const bannerClearedMs = Date.now() - unlockStartedAtMs
			expect(bannerClearedMs).toBeLessThan(15_000)

			// Takeover runs after the response, so the lock ends up owned by this
			// window rather than left released or still held by the other instance.
			await expect.poll(async () => readLockHolder(lockPath), { timeout: 30_000 }).toMatch(/^vscode-[0-9a-f-]{36}$/)
			const lockOwnedMs = Date.now() - unlockStartedAtMs

			// Report the measured latency so a regression toward the old 30s poll
			// recovery is visible in the run output, not just in the pass/fail bit.
			console.log(
				`[unlock-latency] bannerClearedMs=${bannerClearedMs} lockOwnedMs=${lockOwnedMs} (previous failure mode recovered only via the 30s poll)`,
			)

			// The task becomes interactive rather than staying display-only.
			await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(BODY_MARKER, { exact: true })).toBeVisible({ timeout: 15_000 })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
