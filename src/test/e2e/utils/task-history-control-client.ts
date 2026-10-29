import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import type {
    RuntimeHealthSample,
    TaskHistoryControlRequestInput,
    TaskHistoryControlResponse,
} from "@/test/e2e-control/task-history-control"

const CONTROL_RESPONSE_TIMEOUT_MS = 60_000
/**
 * The response is polled at a fixed short interval because callers time the round
 * trip: a backed-off poll would round every measurement up to the next doubling of
 * its wait, so a 640 ms response would read as about 1270 ms.
 */
const CONTROL_RESPONSE_POLL_MS = 10

/** The parsed response, or undefined while it is absent or still being written. */
async function readControlResponse(responsePath: string): Promise<TaskHistoryControlResponse | undefined> {
    const content = await readFile(responsePath, "utf8").catch(() => undefined)
    if (!content?.endsWith("\n")) return undefined
    try {
        return JSON.parse(content) as TaskHistoryControlResponse
    } catch {
        return undefined
    }
}

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
        const deadline = Date.now() + timeoutMs
        for (;;) {
            const response = await readControlResponse(responsePath)
            if (response) return response
            if (Date.now() > deadline) throw new Error(`Task history control did not respond within ${timeoutMs}ms`)
            await new Promise((resolve) => setTimeout(resolve, CONTROL_RESPONSE_POLL_MS))
        }
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

/**
 * Samples Extension Host health. `collectGarbage` forces a full GC first, so
 * the heap figure reflects retained memory rather than transient garbage.
 */
export async function readExtensionHostRuntimeHealth(
    controlDirectory: string,
    options: { collectGarbage?: boolean } = {},
): Promise<RuntimeHealthSample> {
    const response = await requestTaskHistoryControl(controlDirectory, {
        action: "runtime-health",
        collectGarbage: options.collectGarbage === true,
    })
    if (!response.success || !response.runtimeHealth) {
        throw new Error(response.error ?? "The E2E control channel did not return runtime health")
    }
    return response.runtimeHealth
}
