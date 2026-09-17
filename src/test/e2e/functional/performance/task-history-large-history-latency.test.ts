import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { MultiInstanceLauncher, type MultiInstanceSurface } from "@e2e/utils/multi-instance"
import { countStoredTaskHistory, seedLegacyTaskHistory } from "@e2e/utils/task-history-store"
import { expect } from "@playwright/test"
import type { HistoryItem } from "@shared/HistoryItem"

interface ControlResponse {
	success: boolean
	updateDurationMs?: number
	error?: string
}

/**
 * Upper bound for a single task-history metadata update.
 *
 * The reported defect was a metadata write that rewrote a 95 MB history under
 * the cross-process lock, so a real regression lands in the hundreds of
 * milliseconds or worse. The bound is deliberately loose: it must catch a
 * return to whole-file work without turning CI timing noise into failures.
 */
const UPDATE_BUDGET_MS = 750

const SEEDED_TASK_COUNT = 400
const SEEDED_REVISIONS_PER_TASK = 25

/**
 * Seed a legacy history that already carries many superseded revisions per
 * task, reproducing the shape a long-lived installation reaches.
 */
async function seedLargeHistory(dlineDocsDir: string): Promise<void> {
	const items: HistoryItem[] = []
	let ts = 1
	for (let revision = 0; revision < SEEDED_REVISIONS_PER_TASK; revision++) {
		for (let task = 0; task < SEEDED_TASK_COUNT; task++) {
			items.push({
				id: `seeded-task-${task}`,
				ts: ts++,
				// Pad the record so the history resembles real volume.
				task: `seeded revision ${revision} ${"x".repeat(512)}`,
				tokensIn: revision,
				tokensOut: revision,
				totalCost: 0,
			})
		}
	}
	await seedLegacyTaskHistory(dlineDocsDir, items)
}

async function updateAndFlush(surface: MultiInstanceSurface, item: HistoryItem): Promise<ControlResponse> {
	await mkdir(surface.controlDirectory, { recursive: true })
	const requestId = randomUUID()
	const requestPath = path.join(surface.controlDirectory, `${requestId}.request.json`)
	const responsePath = path.join(surface.controlDirectory, `${requestId}.response.json`)
	await writeFile(requestPath, `${JSON.stringify({ id: requestId, action: "update-and-flush", item })}\n`, "utf8")
	return await E2ETestHelper.waitForValue(async () => {
		const content = await readFile(responsePath, "utf8").catch(() => undefined)
		return content ? (JSON.parse(content) as ControlResponse) : undefined
	}, 60_000)
}

e2e(
	"Task history stays responsive and keeps one row per task on a large history",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		await seedLargeHistory(dlineDocsDir)

		const launcher = new MultiInstanceLauncher({ dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir })
		try {
			const instance = await launcher.launch("task-history-latency")

			// The import collapses the superseded revisions on first launch, and the
			// task id is the store's primary key, so exactly one row per task
			// survives no matter how many revisions the legacy file carried.
			await expect.poll(() => countStoredTaskHistory(dlineDocsDir), { timeout: 120_000 }).toBe(SEEDED_TASK_COUNT)

			// A metadata update must not wait on whole-history work.
			const response = await updateAndFlush(instance, {
				id: `latency-probe-${Date.now()}`,
				ts: Date.now(),
				task: "large history latency probe",
				tokensIn: 1,
				tokensOut: 1,
				totalCost: 0,
			})
			expect(response).toMatchObject({ success: true })
			expect(response.updateDurationMs).toBeLessThan(UPDATE_BUDGET_MS)
		} finally {
			await launcher.dispose()
		}
	},
)

e2e(
	"Concurrent instances update a large task history without lock starvation",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		await seedLargeHistory(dlineDocsDir)

		const launcher = new MultiInstanceLauncher({ dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir })
		try {
			const [instanceA, instanceB] = await Promise.all([
				launcher.launch("task-history-load-a"),
				launcher.launch("task-history-load-b"),
			])
			const baseTs = Date.now()

			// Both windows watch the same file, so a write in one triggers a reload in
			// the other. Without coalescing they exhaust the bounded lock retry budget
			// and the update fails outright.
			const responses = await Promise.all([
				updateAndFlush(instanceA, {
					id: `concurrent-a-${baseTs}`,
					ts: baseTs + 1,
					task: "concurrent A",
					tokensIn: 1,
					tokensOut: 1,
					totalCost: 0,
				}),
				updateAndFlush(instanceB, {
					id: `concurrent-b-${baseTs}`,
					ts: baseTs + 2,
					task: "concurrent B",
					tokensIn: 1,
					tokensOut: 1,
					totalCost: 0,
				}),
			])

			for (const response of responses) {
				expect(response).toMatchObject({ success: true })
				expect(response.updateDurationMs).toBeLessThan(UPDATE_BUDGET_MS)
			}
		} finally {
			await launcher.dispose()
		}
	},
)
