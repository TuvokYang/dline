import { mkdir, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect } from "@playwright/test"
import { E2ETestHelper, e2e } from "./utils/helpers"
import { countStoredTaskHistory } from "./utils/task-history-store"

const TASK_TEXT = "E2E_TASK_START_LATENCY_TASK"
const TURN_1_DONE = "E2E_TASK_START_LATENCY_TURN_1_DONE"

/**
 * Field reports show 13-15 silent seconds between task creation and the first
 * provider request once the user has accumulated hundreds of historical tasks
 * (833 tasks / 132MB of ui_messages.jsonl in the reported profile). The startup
 * path emits no log line across that span, so this test reconstructs the same
 * conditions and measures the gap from the Dline Output log.
 *
 * Seed volume is deliberately close to the reported profile: enough history for
 * per-task startup work to dominate, while still finishing inside the E2E budget.
 */
const SEEDED_TASK_COUNT = 800
const REVISIONS_PER_TASK = 12
/**
 * Checkpoint cost is driven by how much workspace content the shadow git has to
 * stage for its baseline, not by task history alone. An empty E2E workspace
 * stages in ~100ms and hides the stall entirely, while a real project (the
 * reported profile is this repository) takes seconds. Seed enough files to put
 * the baseline staging cost in the same regime.
 */
const WORKSPACE_FILE_COUNT = 4_000
const WORKSPACE_FILE_BYTES = 2_048
/**
 * Budget for the startup work that precedes checkpoint initialization.
 *
 * Checkpoint initialization is deliberately blocking: the baseline must capture
 * the workspace before the model can edit a file, otherwise the first restore
 * point already contains model edits. Its duration scales with workspace size,
 * so it is measured and reported separately instead of being budgeted here.
 *
 * What this budget protects is everything else between pressing send and the
 * checkpoint starting - store clearing, state posting and task persistence -
 * which is where the reported 13-15s stall lived. Building the checkpoint
 * manager also scans the seeded workspace, which measures around 4s here, so
 * the budget sits above that while staying far below the reported regression.
 */
const PRE_CHECKPOINT_BUDGET_MS = 8_000

const LOG_TIMESTAMP = String.raw`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})`
// `sending API request` is emitted at info level, so it is present regardless of
// the log level the host was started with, unlike the debug-level task markers.
const API_REQUEST_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[info\\] \\[Task (\\d+)\\] sending API request`)
const CHECKPOINT_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[info\\] Creating new CheckpointTracker for task (\\d+)$`)

function parseLogTimestamp(raw: string): number {
	return new Date(raw.replace(" ", "T")).getTime()
}

/** Find the first log line at or after sinceMs whose pattern matches, optionally pinned to one task. */
function findLogMoment(output: string, pattern: RegExp, sinceMs: number, taskId?: string): number | undefined {
	for (const line of output.split(/\r?\n/)) {
		const match = pattern.exec(line)
		if (!match) continue
		if (taskId !== undefined && match[2] !== undefined && match[2] !== taskId) continue
		const timestampMs = parseLogTimestamp(match[1]!)
		if (timestampMs < sinceMs) continue
		return timestampMs
	}
	return undefined
}

/**
 * Write a historical task directory that mirrors the persisted production shape:
 * a metadata entry plus a ui_messages.jsonl carrying several revisions of the
 * same task, which is what accumulates in a long-lived profile.
 */
async function seedHistoricalTask(dlineDocsDir: string, taskId: string, index: number): Promise<void> {
	const taskDir = path.join(dlineDocsDir, "tasks", taskId)
	await mkdir(taskDir, { recursive: true })

	const baseTs = Number(taskId)
	const lines: string[] = [
		JSON.stringify({
			ts: baseTs,
			type: "say",
			say: "task",
			text: `Seeded history task ${index}`,
		}),
	]
	for (let revision = 0; revision < REVISIONS_PER_TASK; revision++) {
		const ts = baseTs + revision * 2 + 1
		lines.push(
			JSON.stringify({
				ts,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					requestId: `req_${ts}`,
					modelId: "dline-e2e-model",
					provider: "openai",
					tokensIn: 3312,
					tokensOut: 217,
					cacheReads: 123456,
					cost: 0.018179,
					mode: "act",
				}),
			}),
		)
		lines.push(
			JSON.stringify({
				ts: ts + 1,
				type: "say",
				say: "text",
				text: `Seeded assistant turn ${revision} for task ${index}`.padEnd(512, " "),
			}),
		)
	}

	await writeFile(path.join(taskDir, "ui_messages.jsonl"), `${lines.join("\n")}\n`, "utf8")
	await writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8")
}

/** Fill the workspace with source-like files so the checkpoint baseline has real content to stage. */
async function seedWorkspaceFiles(workspaceDir: string): Promise<void> {
	const filler = "x".repeat(WORKSPACE_FILE_BYTES)
	const filesPerDirectory = 100
	const directoryCount = Math.ceil(WORKSPACE_FILE_COUNT / filesPerDirectory)
	for (let dirIndex = 0; dirIndex < directoryCount; dirIndex++) {
		const dir = path.join(workspaceDir, "seeded-src", `module-${dirIndex}`)
		await mkdir(dir, { recursive: true })
		const writes: Promise<void>[] = []
		for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex++) {
			writes.push(
				writeFile(
					path.join(dir, `file-${fileIndex}.ts`),
					`// seeded workspace file ${dirIndex}-${fileIndex}\nexport const value${fileIndex} = "${filler}"\n`,
					"utf8",
				),
			)
		}
		await Promise.all(writes)
	}
}

/** Append the seeded tasks to the shared task history index the extension reads at startup. */
async function seedTaskHistoryIndex(dlineDocsDir: string, taskIds: string[]): Promise<void> {
	const lines = taskIds.map((taskId, index) =>
		JSON.stringify({
			id: taskId,
			ts: Number(taskId),
			task: `Seeded history task ${index}`,
			tokensIn: 3312,
			tokensOut: 217,
			cacheWrites: 0,
			cacheReads: 123456,
			totalCost: 0.018179,
			size: 26891,
			isFavorited: false,
		}),
	)
	await writeFile(path.join(dlineDocsDir, "tasks", "taskHistory.jsonl"), `${lines.join("\n")}\n`, "utf8")
}

e2e(
	"Task start latency - a large task history must not stall the first provider request",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)

		// Seed before launch so SQLite performs the real one-time history import and
		// the measurement cannot include filesystem writes still draining from the test.
		await rm(path.join(dlineDir, "checkpoints"), { recursive: true, force: true })
		await seedWorkspaceFiles(workspaceDir)

		const seededTaskIds: string[] = []
		const seedBaseTs = Date.now() - SEEDED_TASK_COUNT * 60_000
		for (let index = 0; index < SEEDED_TASK_COUNT; index++) {
			const taskId = String(seedBaseTs + index * 60_000)
			seededTaskIds.push(taskId)
			await seedHistoricalTask(dlineDocsDir, taskId, index)
		}
		await seedTaskHistoryIndex(dlineDocsDir, seededTaskIds)

		const app = await openVSCode(workspaceDir)
		const page = await app.firstWindow()
		try {
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await expect.poll(() => countStoredTaskHistory(dlineDocsDir), { timeout: 120_000 }).toBe(SEEDED_TASK_COUNT)

			server.resetOpenAiMock()
			server.enqueueResponses("openai-compatible-chat", {
				type: "tool",
				id: "call_task_start_latency_complete",
				name: "attempt_completion",
				arguments: { result: TURN_1_DONE },
			})

			await sidebar.getByTestId("chat-input").fill(TASK_TEXT)
			const sendClickedAtMs = Date.now()
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText(TURN_1_DONE, { exact: false }).last()).toBeVisible({ timeout: 240_000 })
			await expect(sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible({
				timeout: 240_000,
			})

			const measurement = await E2ETestHelper.waitForValue(async () => {
				const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir)
				if (!output) return undefined
				const requestAtMs = findLogMoment(output, API_REQUEST_PATTERN, sendClickedAtMs)
				if (requestAtMs === undefined) return undefined
				const checkpointAtMs = findLogMoment(output, CHECKPOINT_PATTERN, sendClickedAtMs)
				return {
					startedAtMs: sendClickedAtMs,
					requestAtMs,
					sendToRequestMs: requestAtMs - sendClickedAtMs,
					sendToCheckpointMs: checkpointAtMs === undefined ? undefined : checkpointAtMs - sendClickedAtMs,
				}
			}, 240_000)

			console.log(
				`[task-start-latency] sendToRequestMs=${measurement.sendToRequestMs} ` +
					`sendToCheckpointMs=${measurement.sendToCheckpointMs ?? "n/a"} ` +
					`seededTasks=${SEEDED_TASK_COUNT}`,
			)
			const timelineOutput = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
			const timelineMarkers =
				/Task lock acquired|Creating new CheckpointTracker|Initializing shadow git|Shadow git initialization completed|checkpoint add operation|attemptApiRequest: start|loadContext timing|startTask timing|startTask handoff timing/
			for (const line of timelineOutput.split(/\r?\n/)) {
				if (!timelineMarkers.test(line)) continue
				const timestampMatch = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/.exec(line)
				if (!timestampMatch) continue
				if (parseLogTimestamp(timestampMatch[1]!) < measurement.startedAtMs) continue
				console.log(`[task-start-latency][timeline] ${line.trim()}`)
			}
			await e2e.info().attach("task-start-latency.json", {
				body: Buffer.from(
					JSON.stringify(
						{
							seededTasks: SEEDED_TASK_COUNT,
							revisionsPerTask: REVISIONS_PER_TASK,
							preCheckpointBudgetMs: PRE_CHECKPOINT_BUDGET_MS,
							...measurement,
						},
						null,
						2,
					),
					"utf8",
				),
				contentType: "application/json",
			})

			if (typeof measurement.sendToCheckpointMs !== "number") {
				throw new Error("The checkpoint start marker was never observed, so the budget would be vacuous")
			}
			expect(
				measurement.sendToCheckpointMs,
				`send to checkpoint start must stay under ${PRE_CHECKPOINT_BUDGET_MS}ms ` +
					`with ${SEEDED_TASK_COUNT} historical tasks ` +
					`(measured ${measurement.sendToCheckpointMs}ms, full send-to-request ${measurement.sendToRequestMs}ms)`,
			).toBeLessThan(PRE_CHECKPOINT_BUDGET_MS)

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
				/e2e_mock_queue_exhausted/i,
				/No scripted E2E response remains/i,
				/Dline instance aborted/i,
				/Error getting latest git commit hash/i,
			])
		} catch (error) {
			const screenshotPath = e2e.info().outputPath("vscode-failure.png")
			await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 }).catch(() => undefined)
			await e2e
				.info()
				.attach("vscode-failure.png", { path: screenshotPath, contentType: "image/png" })
				.catch(() => undefined)
			throw error
		} finally {
			await app.close()
		}
	},
)
