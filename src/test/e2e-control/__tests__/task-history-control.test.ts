import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Controller } from "@/core/controller"
import { startTaskHistoryControl, type TaskHistoryControlHandle } from "../task-history-control"

/**
 * Minimal Controller stand-in: the channel only needs to record the update and
 * flush, so the test can assert the request actually reached the extension.
 */
function createControllerStub(): { controller: Controller; updatedIds: string[] } {
	const updatedIds: string[] = []
	const controller = {
		updateTaskHistory: async (item: { id: string }) => {
			updatedIds.push(item.id)
		},
		stateManager: { taskHistory: { flush: async () => undefined } },
	} as unknown as Controller
	return { controller, updatedIds }
}

async function waitForResponse(responsePath: string, timeoutMs: number): Promise<string | undefined> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const content = await fs.readFile(responsePath, "utf8").catch(() => undefined)
		if (content) {
			return content
		}
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	return undefined
}

describe("startTaskHistoryControl", () => {
	let controlDirectory: string | undefined
	let handle: TaskHistoryControlHandle | undefined

	afterEach(async () => {
		await handle?.dispose()
		handle = undefined
		if (controlDirectory) {
			await rm(controlDirectory, { force: true, recursive: true })
			controlDirectory = undefined
		}
	})

	it("answers a request written after the watcher started", async () => {
		controlDirectory = await mkdtemp(path.join(tmpdir(), "dline-task-history-control-"))
		const { controller, updatedIds } = createControllerStub()
		handle = await startTaskHistoryControl(controller, controlDirectory)

		const requestId = "request-after-start"
		const requestPath = path.join(controlDirectory, `${requestId}.request.json`)
		const responsePath = path.join(controlDirectory, `${requestId}.response.json`)
		await fs.writeFile(
			requestPath,
			`${JSON.stringify({ id: requestId, action: "update-and-flush", item: { id: "task-1", ts: 1 } })}\n`,
			"utf8",
		)

		const content = await waitForResponse(responsePath, 10_000)
		expect(content, "the control channel never wrote a response").toBeDefined()
		expect(JSON.parse(content as string)).toMatchObject({ id: requestId, success: true })
		expect(updatedIds).toEqual(["task-1"])
	})

	it("answers a request that already existed before the watcher started", async () => {
		controlDirectory = await mkdtemp(path.join(tmpdir(), "dline-task-history-control-"))
		const requestId = "request-before-start"
		const requestPath = path.join(controlDirectory, `${requestId}.request.json`)
		const responsePath = path.join(controlDirectory, `${requestId}.response.json`)
		await fs.writeFile(
			requestPath,
			`${JSON.stringify({ id: requestId, action: "update-and-flush", item: { id: "task-2", ts: 2 } })}\n`,
			"utf8",
		)

		const { controller, updatedIds } = createControllerStub()
		handle = await startTaskHistoryControl(controller, controlDirectory)

		const content = await waitForResponse(responsePath, 10_000)
		expect(content, "the control channel never wrote a response").toBeDefined()
		expect(JSON.parse(content as string)).toMatchObject({ id: requestId, success: true })
		expect(updatedIds).toEqual(["task-2"])
	})

	it("returns an immediate extension-host runtime health sample", async () => {
		controlDirectory = await mkdtemp(path.join(tmpdir(), "dline-task-history-control-"))
		const { controller } = createControllerStub()
		handle = await startTaskHistoryControl(controller, controlDirectory)

		const requestId = "runtime-health"
		const requestPath = path.join(controlDirectory, `${requestId}.request.json`)
		const responsePath = path.join(controlDirectory, `${requestId}.response.json`)
		await fs.writeFile(requestPath, `${JSON.stringify({ id: requestId, action: "runtime-health" })}\n`, "utf8")

		const content = await waitForResponse(responsePath, 10_000)
		expect(content, "the control channel never wrote a response").toBeDefined()
		const response = JSON.parse(content as string)
		expect(response).toMatchObject({ id: requestId, success: true })
		expect(response.runtimeHealth).toMatchObject({
			capturedAtMs: expect.any(Number),
			eventLoopDelayMs: expect.any(Number),
			heapUsedBytes: expect.any(Number),
			heapTotalBytes: expect.any(Number),
			rssBytes: expect.any(Number),
			externalBytes: expect.any(Number),
			arrayBuffersBytes: expect.any(Number),
			uptimeSeconds: expect.any(Number),
		})
		expect(response.runtimeHealth.rssBytes).toBeGreaterThan(0)
		expect(response.runtimeHealth.eventLoopDelayMs).toBeGreaterThanOrEqual(0)
	})
})
