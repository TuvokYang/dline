import { promises as fs } from "node:fs"
import * as path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import type { Controller } from "@/core/controller"
import type { HistoryItem } from "@/shared/HistoryItem"
import { Logger } from "@/shared/services/Logger"

const REQUEST_SUFFIX = ".request.json"
const RESPONSE_SUFFIX = ".response.json"

export interface RuntimeHealthSample {
	capturedAtMs: number
	eventLoopDelayMs: number
	heapUsedBytes: number
	heapTotalBytes: number
	rssBytes: number
	externalBytes: number
	arrayBuffersBytes: number
	uptimeSeconds: number
}

export type TaskHistoryControlRequest =
	| { id: string; action: "update-and-flush"; item: HistoryItem }
	| { id: string; action: "runtime-health" }

export type TaskHistoryControlRequestInput = { action: "update-and-flush"; item: HistoryItem } | { action: "runtime-health" }

export interface TaskHistoryControlResponse {
	id: string
	success: boolean
	updateDurationMs?: number
	runtimeHealth?: RuntimeHealthSample
	error?: string
}

export interface TaskHistoryControlHandle {
	dispose(): Promise<void>
}

async function captureRuntimeHealth(): Promise<RuntimeHealthSample> {
	const scheduledAt = performance.now()
	await new Promise<void>((resolve) => setImmediate(resolve))
	const memory = process.memoryUsage()
	return {
		capturedAtMs: Date.now(),
		eventLoopDelayMs: Math.max(0, performance.now() - scheduledAt),
		heapUsedBytes: memory.heapUsed,
		heapTotalBytes: memory.heapTotal,
		rssBytes: memory.rss,
		externalBytes: memory.external,
		arrayBuffersBytes: memory.arrayBuffers,
		uptimeSeconds: process.uptime(),
	}
}

/**
 * Starts an E2E-only filesystem control channel for TaskHistory operations.
 * Each VS Code instance receives a distinct directory, avoiding fixed-port
 * conflicts while still exercising the real Extension Host Controller.
 */
export async function startTaskHistoryControl(
	controller: Controller,
	controlDirectory: string,
): Promise<TaskHistoryControlHandle> {
	await fs.mkdir(controlDirectory, { recursive: true })
	let watcher: FSWatcher | undefined
	let disposed = false
	const processed = new Set<string>()

	const processRequest = async (requestPath: string): Promise<void> => {
		// The watcher reports every file in the directory, including the
		// responses written back here, so only requests are answered.
		if (!requestPath.endsWith(REQUEST_SUFFIX)) return
		if (disposed || processed.has(requestPath)) return
		processed.add(requestPath)
		let request: TaskHistoryControlRequest | undefined
		let response: TaskHistoryControlResponse
		try {
			request = JSON.parse(await fs.readFile(requestPath, "utf8")) as TaskHistoryControlRequest
			if (!request.id) throw new Error("Invalid TaskHistory E2E control request")
			switch (request.action) {
				case "update-and-flush": {
					if (!request.item?.id) throw new Error("Invalid TaskHistory E2E control request")
					const startedAt = performance.now()
					await controller.updateTaskHistory(request.item)
					const updateDurationMs = performance.now() - startedAt
					await controller.stateManager.taskHistory.flush()
					response = { id: request.id, success: true, updateDurationMs }
					break
				}
				case "runtime-health":
					response = { id: request.id, success: true, runtimeHealth: await captureRuntimeHealth() }
					break
				default:
					throw new Error("Invalid TaskHistory E2E control request")
			}
		} catch (error) {
			response = {
				id: request?.id ?? path.basename(requestPath),
				success: false,
				error: error instanceof Error ? (error.stack ?? error.message) : String(error),
			}
		}

		const responsePath = `${requestPath.slice(0, -REQUEST_SUFFIX.length)}${RESPONSE_SUFFIX}`
		await fs.writeFile(responsePath, `${JSON.stringify(response)}\n`, "utf8")
	}

	// Watch the directory rather than a glob: chokidar removed glob support in
	// v4, so a glob path is taken literally and never matches a real file,
	// leaving every request unanswered. `ignoreInitial: false` also delivers a
	// request that was written before the watcher started.
	watcher = chokidar.watch(controlDirectory, {
		depth: 0,
		ignoreInitial: false,
		awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
	})
	watcher.on("add", (requestPath) => void processRequest(requestPath))
	watcher.on("error", (error) => Logger.error("[TaskHistoryE2EControl] Watcher error:", error))

	return {
		async dispose(): Promise<void> {
			if (disposed) return
			disposed = true
			await watcher?.close()
		},
	}
}
