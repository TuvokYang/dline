import { ClineMessage } from "./ExtensionMessage"

/**
 * Combines API request start and finish messages in an array of ClineMessages.
 *
 * This function looks for pairs of 'api_req_started' and 'api_req_finished' messages.
 * When it finds a pair, it combines them into a single 'api_req_combined' message.
 * The JSON data in the text fields of both messages are merged.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns A new array of ClineMessage objects with API requests combined.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data"}', ts: 1000 },
 *   { type: "say", say: "api_req_finished", text: '{"cost":0.005}', ts: 1001 }
 * ];
 * const result = combineApiRequests(messages);
 * // Result: [{ type: "say", say: "api_req_started", text: '{"request":"GET /api/data","cost":0.005}', ts: 1000 }]
 */
export function combineApiRequests(messages: ClineMessage[]): ClineMessage[] {
	// Index combined requests by message timestamp for O(1) lookup during the
	// final output pass. Keep the FIRST combined entry for a duplicated ts to
	// preserve old semantics.
	const combinedByTs = new Map<number, ClineMessage>()

	// Pre-scan finished positions so every started message can find its first
	// following finished message in O(1) via a monotonic pointer. The original
	// implementation rescaned forward from every started (O(N^2) once
	// reasoning/text/tool messages interleave between the pair), which dominated
	// buildState() in long conversations (901ms for a 22.7K-message real task).
	// NOTE: this preserves the original pairing semantics exactly — a started
	// message pairs with the FIRST finished after it, and the outer loop jumps
	// past the consumed finished (skipping any interleaved started).
	const finishedPositions: number[] = []
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].type === "say" && messages[i].say === "api_req_finished") {
			finishedPositions.push(i)
		}
	}

	let nextFinished = 0
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.type !== "say" || msg.say !== "api_req_started") {
			continue
		}

		// Advance past finished messages that precede this started message.
		while (nextFinished < finishedPositions.length && finishedPositions[nextFinished] <= i) {
			nextFinished++
		}
		if (nextFinished >= finishedPositions.length) {
			// No matching api_req_finished found: keep the original api_req_started.
			continue
		}

		const finishedIndex = finishedPositions[nextFinished]!
		const startedRequest = JSON.parse(msg.text || "{}")
		const finishedRequest = JSON.parse(messages[finishedIndex]!.text || "{}")
		const combinedMessage = {
			...msg,
			text: JSON.stringify({
				...startedRequest,
				...finishedRequest,
			}),
		}
		if (!combinedByTs.has(msg.ts)) {
			combinedByTs.set(msg.ts, combinedMessage)
		}

		// Consume the finished message and skip past it (mirrors the original
		// `i = j` jump; interleaved started messages are not paired).
		nextFinished++
		i = finishedIndex
	}

	// Replace original api_req_started and remove api_req_finished in one
	// pre-sized pass. Avoiding the unused combined-message array and the
	// filter().map() intermediate materially reduces GC pressure on long tasks.
	const result = new Array<ClineMessage>(messages.length - finishedPositions.length)
	let resultIndex = 0
	for (const msg of messages) {
		if (msg.type === "say" && msg.say === "api_req_finished") {
			continue
		}
		result[resultIndex++] = msg.type === "say" && msg.say === "api_req_started" ? (combinedByTs.get(msg.ts) ?? msg) : msg
	}
	return result
}
