import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { MultiInstanceLauncher, type MultiInstanceSurface } from "@e2e/utils/multi-instance"
import { countStoredRowsForTask } from "@e2e/utils/task-history-store"
import { expect } from "@playwright/test"
import type { HistoryItem } from "@shared/HistoryItem"

interface ControlResponse {
	success: boolean
	updateDurationMs?: number
	error?: string
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
	}, 30_000)
}

e2e(
	"Task history same-id updates remain one physical record across VS Code instances",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const launcher = new MultiInstanceLauncher({ dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir })
		try {
			const instanceA = await launcher.launch("task-history-a")
			const instanceB = await launcher.launch("task-history-b")
			const taskId = `e2e-task-history-${Date.now()}`
			const base: HistoryItem = {
				id: taskId,
				ts: Date.now(),
				task: "Task history cross-instance RED",
				tokensIn: 1,
				tokensOut: 1,
				totalCost: 0,
			}

			const [responseA, responseB] = await Promise.all([
				updateAndFlush(instanceA, { ...base, ts: base.ts + 1, tokensIn: 11 }),
				updateAndFlush(instanceB, { ...base, ts: base.ts + 2, tokensOut: 22 }),
			])
			expect(responseA).toMatchObject({ success: true })
			expect(responseB).toMatchObject({ success: true })

			await expect.poll(() => countStoredRowsForTask(dlineDocsDir, taskId), { timeout: 30_000 }).toBe(1)
		} finally {
			await launcher.dispose()
		}
	},
)
