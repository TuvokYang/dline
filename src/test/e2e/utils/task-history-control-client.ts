import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import type {
	RuntimeHealthSample,
	TaskHistoryControlRequestInput,
	TaskHistoryControlResponse,
} from "@/test/e2e-control/task-history-control"
import { E2ETestHelper } from "./helpers"

const CONTROL_RESPONSE_TIMEOUT_MS = 60_000

export async function requestTaskHistoryControl(
	controlDirectory: string,
	input: TaskHistoryControlRequestInput,
	timeoutMs = CONTROL_RESPONSE_TIMEOUT_MS,
): Promise<TaskHistoryControlResponse> {
	await mkdir(controlDirectory, { recursive: true })
	const requestId = randomUUID()
	const requestPath = path.join(controlDirectory, `${requestId}.request.json`)
	const responsePath = path.join(controlDirectory, `${requestId}.response.json`)
	await writeFile(requestPath, `${JSON.stringify({ id: requestId, ...input })}\n`, "utf8")
	try {
		return await E2ETestHelper.waitForValue(async () => {
			const content = await readFile(responsePath, "utf8").catch(() => undefined)
			return content ? (JSON.parse(content) as TaskHistoryControlResponse) : undefined
		}, timeoutMs)
	} finally {
		await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })])
	}
}

export async function updateTaskHistoryAndFlush(
	controlDirectory: string,
	item: HistoryItem,
): Promise<TaskHistoryControlResponse> {
	return await requestTaskHistoryControl(controlDirectory, { action: "update-and-flush", item })
}

export async function readExtensionHostRuntimeHealth(controlDirectory: string): Promise<RuntimeHealthSample> {
	const response = await requestTaskHistoryControl(controlDirectory, { action: "runtime-health" })
	if (!response.success || !response.runtimeHealth) {
		throw new Error(response.error ?? "The E2E control channel did not return runtime health")
	}
	return response.runtimeHealth
}
