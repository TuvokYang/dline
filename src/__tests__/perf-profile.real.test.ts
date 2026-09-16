import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { describe, it } from "vitest"
import { combineApiRequests } from "../shared/combineApiRequests"
import { combineCommandSequences } from "../shared/combineCommandSequences"
import { ClineMessage } from "../shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens, getLastTaskProgressText } from "../shared/getApiMetrics"

/** Reference implementation of the ORIGINAL pairing algorithm (semantics lock). */
function combineApiRequestsReference(messages: ClineMessage[]): ClineMessage[] {
	const combinedApiRequests: ClineMessage[] = []

	for (let i = 0; i < messages.length; i++) {
		if (messages[i].type === "say" && messages[i].say === "api_req_started") {
			const startedRequest = JSON.parse(messages[i].text || "{}")
			let j = i + 1

			while (j < messages.length) {
				if (messages[j].type === "say" && messages[j].say === "api_req_finished") {
					const finishedRequest = JSON.parse(messages[j].text || "{}")
					const combinedRequest = {
						...startedRequest,
						...finishedRequest,
					}
					combinedApiRequests.push({
						...messages[i],
						text: JSON.stringify(combinedRequest),
					})
					i = j
					break
				}
				j++
			}

			if (j === messages.length) {
				combinedApiRequests.push(messages[i])
			}
		}
	}

	return messages
		.filter((msg) => !(msg.type === "say" && msg.say === "api_req_finished"))
		.map((msg) => {
			if (msg.type === "say" && msg.say === "api_req_started") {
				const combinedRequest = combinedApiRequests.find((req) => req.ts === msg.ts)
				return combinedRequest || msg
			}
			return msg
		})
}

// Temporary profiling harness: load an explicitly selected field-log task's
// ui_messages.jsonl and measure each buildState pipeline step.
const REAL_MESSAGES_PATH = process.env.DLINE_PERF_PROFILE_MESSAGES_PATH

function loadRealMessages(): ClineMessage[] {
	if (!REAL_MESSAGES_PATH) {
		throw new Error("DLINE_PERF_PROFILE_MESSAGES_PATH is required to run the real-task profile")
	}
	const raw = readFileSync(REAL_MESSAGES_PATH, "utf8")
	const lines = raw.split("\n").filter((line) => line.trim().length > 0)
	return lines.map((line) => JSON.parse(line) as ClineMessage)
}

function measure<T>(label: string, fn: () => T): T {
	const start = performance.now()
	const result = fn()
	const elapsed = performance.now() - start
	console.log(`[profile] ${label}: ${elapsed.toFixed(1)}ms`)
	return result
}

describe.skipIf(!REAL_MESSAGES_PATH)("real-task buildState pipeline profile", () => {
	it("profiles each stage on the 22.7K-message real task", () => {
		const messages = loadRealMessages()
		console.log(`[profile] loaded ${messages.length} messages`)

		// 1. combineCommandSequences (full O(N) pass with map-based merging)
		const combinedCommands = measure("combineCommandSequences", () => combineCommandSequences(messages))

		// 2. combineApiRequests (monotonic-pointer O(N) after fix)
		const combinedApi = measure("combineApiRequests", () => combineApiRequests(combinedCommands))

		// 2b. Semantics lock: new output must equal the original algorithm's output.
		const reference = combineApiRequestsReference(combinedCommands)
		if (JSON.stringify(reference) !== JSON.stringify(combinedApi)) {
			throw new Error("combineApiRequests output diverges from the reference implementation")
		}
		console.log(`[profile] semantics lock: outputs equal (${combinedApi.length} messages)`)

		// 3. getApiMetrics (per-message JSON.parse for api_req messages)
		measure("getApiMetrics", () => getApiMetrics(combinedApi))

		// 4. getLastApiReqTotalTokens (reverse scan)
		measure("getLastApiReqTotalTokens", () => getLastApiReqTotalTokens(combinedApi))

		// 5. getLastTaskProgressText (reverse scan)
		measure("getLastTaskProgressText", () => getLastTaskProgressText(messages))

		// 6. rawMessages spread copy
		measure("spread copy", () => [...messages])

		// 7. full JSON.stringify of the state-like payload size (265KB observed in logs)
		measure("JSON.stringify(messages)", () => JSON.stringify(messages))

		// 8. Slice the last 100 messages (firstItemIndex window)
		measure("slice last 100", () => messages.slice(Math.max(0, messages.length - 100)))

		// 9. Message text histogram: how many messages carry big text?
		let bigText = 0
		let totalTextBytes = 0
		for (const m of messages) {
			if (m.text) {
				totalTextBytes += m.text.length
				if (m.text.length > 10_000) bigText++
			}
		}
		console.log(`[profile] bigText(>10KB): ${bigText}, totalTextBytes: ${totalTextBytes}`)
	})
})
