import { createHash } from "node:crypto"
import type { UiApiReqInfo, UiMessage } from "@shared/ExtensionMessage"

export interface LegacyUiMessageSource {
	getAll(): ReadonlyArray<UiMessage>
}

export interface LegacyUsageFact {
	readonly sourceKey: string
	readonly messageTs: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheWriteTokens: number
	readonly cacheReadTokens: number
	readonly cacheUsageReported: boolean
	readonly totalCost?: number
	readonly currency?: string
}

export interface LegacyRoundCandidate extends LegacyUsageFact {
	readonly roundId: string
	readonly logicalRequestId: string
	readonly apiIndex: number
}

export interface LegacyAggregateCandidate extends LegacyUsageFact {
	readonly aggregateKind: "deleted_api_reqs" | "subagent_usage"
}

export interface LegacyUsageParseResult {
	readonly rounds: LegacyRoundCandidate[]
	readonly aggregates: LegacyAggregateCandidate[]
	readonly sourceFingerprint: string
	readonly degraded: boolean
}

/** Extract durable legacy usage facts without reading the physical UIMessage backend. */
export function parseLegacyUsageMessages(taskId: string, messages: readonly UiMessage[]): LegacyUsageParseResult {
	const rounds: LegacyRoundCandidate[] = []
	const aggregates: LegacyAggregateCandidate[] = []
	let degraded = false
	const finishedPositions = messages.flatMap((message, index) =>
		message.type === "say" && message.say === "api_req_finished" ? [index] : [],
	)
	let nextFinished = 0

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (message.type !== "say" || !message.say || !message.text || message.partial === true) continue
		if (message.say === "api_req_started") {
			while ((finishedPositions[nextFinished] ?? Number.POSITIVE_INFINITY) <= index) nextFinished++
			const started = parseInfo(message.text)
			if (!started) {
				degraded = true
				continue
			}
			let merged = started
			let usage = normalizeUsage(started)
			if (!usage) {
				const finishedIndex = finishedPositions[nextFinished]
				const finished = finishedIndex === undefined ? undefined : parseInfo(messages[finishedIndex]?.text)
				if (finishedIndex !== undefined) nextFinished++
				if (finishedIndex !== undefined && !finished) degraded = true
				merged = { ...started, ...finished }
				usage = normalizeUsage(merged)
			}
			if (merged.cancelReason) continue
			if (!usage) continue
			const sourceKey = `ui-message:${taskId}:api_req_started:${message.ts}`
			const logicalRequestId = `legacy-ui:${message.ts}`
			const conversationIndex = message.conversationHistoryIndex
			const apiIndex =
				typeof conversationIndex === "number" && Number.isSafeInteger(conversationIndex) && conversationIndex >= 0
					? conversationIndex
					: rounds.length
			rounds.push({
				...usage,
				sourceKey,
				messageTs: message.ts,
				roundId: `${taskId}:${logicalRequestId}:provider:0`,
				logicalRequestId,
				apiIndex,
			})
			continue
		}
		if (message.say !== "deleted_api_reqs" && message.say !== "subagent_usage") continue
		const info = parseInfo(message.text)
		if (!info) {
			degraded = true
			continue
		}
		const usage = normalizeUsage(info)
		if (!usage) continue
		aggregates.push({
			...usage,
			sourceKey: `ui-message:${taskId}:${message.say}:${message.ts}`,
			messageTs: message.ts,
			aggregateKind: message.say,
		})
	}

	const fingerprintInput = [...rounds, ...aggregates]
		.map(({ sourceKey, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalCost, currency }) => ({
			sourceKey,
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			totalCost: totalCost ?? null,
			currency: currency ?? null,
		}))
		.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
	return {
		rounds,
		aggregates,
		sourceFingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex"),
		degraded,
	}
}

function parseInfo(text: string | undefined): UiApiReqInfo | undefined {
	if (!text) return undefined
	try {
		const value: unknown = JSON.parse(text)
		return typeof value === "object" && value !== null ? (value as UiApiReqInfo) : undefined
	} catch {
		return undefined
	}
}

function normalizeUsage(info: UiApiReqInfo): Omit<LegacyUsageFact, "sourceKey" | "messageTs"> | undefined {
	const input = readNonNegativeInteger(info.tokensIn)
	const output = readNonNegativeInteger(info.tokensOut)
	const write = readNonNegativeInteger(info.cacheWrites)
	const read = readNonNegativeInteger(info.cacheReads)
	const cost = readNonNegativeNumber(info.cost)
	if ((input ?? 0) + (output ?? 0) + (write ?? 0) + (read ?? 0) <= 0 && (cost ?? 0) <= 0) return undefined
	const recovered = info.request === "(recovered from API history)"
	const normalizedInput = recovered ? Math.max(0, (input ?? 0) - (write ?? 0) - (read ?? 0)) : (input ?? 0)
	const cacheUsageReported = (write ?? 0) > 0 || (read ?? 0) > 0
	return {
		inputTokens: normalizedInput,
		outputTokens: output ?? 0,
		cacheWriteTokens: write ?? 0,
		cacheReadTokens: read ?? 0,
		cacheUsageReported,
		...(cost === undefined ? {} : { totalCost: cost }),
		...(typeof info.currency === "string" && info.currency.trim() ? { currency: info.currency.trim() } : {}),
	}
}

function readNonNegativeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

function readNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
