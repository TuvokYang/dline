import type { ClineStorageMessage } from "@shared/messages/content"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NO_COMPLETE_LOGICAL_TURN } from "../../ContextCompactionSession"
import type { ProviderRequestFrame } from "../../executors/provider/service/ProviderRequest"
import { AUTOMATIC_COMPACTION_FAILED } from "../CompactionRoundBarrier"
import { type AdmissionCompaction, FinalContextWindowGuard } from "../FinalContextWindowGuard"

const CONTEXT_WINDOW = 1_000
const TRIGGER_TOKENS = 800

/** Estimates the guard will read, one per measurement, in order. */
const estimates: number[] = []
/** The messages each measurement estimated, so the candidate's shape is observable. */
const measuredMessages: ClineStorageMessage[][] = []

// The projection arithmetic has its own tests; here the candidate's estimate is
// scripted so the guard's own decisions (compact, re-measure, warn, refuse) are
// what each case observes.
vi.mock("@core/context/context-management/context-window-projection", () => ({
	estimateContextWindowCandidate: (input: { messages: ClineStorageMessage[] }) => {
		measuredMessages.push(input.messages)
		const next = estimates.shift()
		if (next === undefined) throw new Error("unexpected measurement")
		return next
	},
	resolveContextWindowProjection: (input: { candidateEstimatedTokens: number; triggerTokens: number }) => ({
		baselineTokens: 0,
		pendingDeltaTokens: 0,
		candidateDeltaTokens: input.candidateEstimatedTokens,
		projectedUsageTokens: input.candidateEstimatedTokens,
		pressureSource: "candidate",
		shouldCompact: input.candidateEstimatedTokens >= input.triggerTokens,
	}),
}))

/** The requests the guard split for the indicator; only the admitted one should be. */
const splits: { providerInput: { messages: ClineStorageMessage[] }; durableMessageCount: number }[] = []
const SPLIT = { durableContextTokens: 200, pendingSendTokens: 60, environmentTokens: 40, totalTokens: 300 }

// Splitting a request into indicator segments has its own tests; here only
// which request is split, and where its round's input starts, is observed.
vi.mock("../../ContextWindowIndicatorProjection", () => ({
	estimateContextWindowIndicatorSegments: (input: (typeof splits)[number]) => {
		splits.push(input)
		return SPLIT
	},
}))

vi.mock("@core/context/context-management/context-window-utils", () => ({
	getContextWindowInfo: () => ({ contextWindow: CONTEXT_WINDOW }),
	computeSummarizeBudget: () => 0,
	computeCompactTrigger: () => TRIGGER_TOKENS,
}))

const HISTORY: ClineStorageMessage[] = [
	{ role: "user", content: [{ type: "text", text: "task" }] },
	{ role: "assistant", content: [{ type: "text", text: "answer" }] },
]

const ENVIRONMENT = "<environment_details>\n# Current Time\nnow\n</environment_details>"

const FRAME = {
	api: { getModel: () => ({ id: "probe-model" }), getProviderId: () => "openai" },
	systemPrompt: "SYSTEM",
	tools: [],
	options: { serverTools: [] },
} as unknown as ProviderRequestFrame

interface Harness {
	readonly guard: FinalContextWindowGuard
	readonly compactForAdmission: ReturnType<typeof vi.fn>
	readonly present: ReturnType<typeof vi.fn>
}

function harness(options: { compaction?: AdmissionCompaction; withCompaction?: boolean } = {}): Harness {
	const compactForAdmission = vi.fn(async () => options.compaction ?? ({ kind: "completed" } as const))
	const present = vi.fn(async () => undefined)
	const guard = new FinalContextWindowGuard({
		taskId: "task-1",
		frames: { frame: async () => FRAME },
		conversation: { messages: async () => [...HISTORY] },
		requestPressures: () => [],
		triggerOptions: () => ({}),
		...(options.withCompaction === false ? {} : { compaction: { compactForAdmission } }),
		failure: { present },
	})
	return { guard, compactForAdmission, present }
}

function lastText(messages: ClineStorageMessage[] | undefined): string {
	const content = messages?.at(-1)?.content
	if (!Array.isArray(content)) return String(content)
	return content.map((block) => ("text" in block ? block.text : "")).join("")
}

describe("FinalContextWindowGuard", () => {
	beforeEach(() => {
		estimates.length = 0
		measuredMessages.length = 0
		splits.length = 0
	})

	it("admits a request that fits without compacting and records its estimate", async () => {
		estimates.push(300)
		const { guard, compactForAdmission } = harness()

		const admission = await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(admission).toEqual({ kind: "ready", environment: ENVIRONMENT })
		expect(compactForAdmission).not.toHaveBeenCalled()
		expect(guard.admittedEstimate()).toBe(300)
		// The round's environment is measured as the trailing user message it will be sent as.
		expect(lastText(measuredMessages[0])).toBe(ENVIRONMENT)
	})

	it("opens the admitted request on its own split, with the round's input after the history it carries", async () => {
		estimates.push(300)
		const { guard } = harness()

		await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(guard.admittedRequest()).toEqual({
			estimatedTokens: 300,
			projectedUsageTokens: 300,
			segments: SPLIT,
		})
		expect(splits).toHaveLength(1)
		// Everything before the latest message was sent already; the environment follows the round's input.
		expect(splits[0]?.durableMessageCount).toBe(HISTORY.length - 1)
		expect(lastText(splits[0]?.providerInput.messages)).toBe(ENVIRONMENT)
	})

	it("compacts a request over the trigger and measures the compacted candidate again", async () => {
		estimates.push(850, 200)
		const { guard, compactForAdmission } = harness()

		const admission = await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(compactForAdmission).toHaveBeenCalledTimes(1)
		expect(admission).toEqual({ kind: "ready", environment: ENVIRONMENT })
		expect(guard.admittedEstimate()).toBe(200)
		expect(measuredMessages).toHaveLength(2)
	})

	it("stops the round with the run's error when compaction fails", async () => {
		estimates.push(850)
		const { guard } = harness({ compaction: { kind: "failed", error: "provider refused" } })

		const admission = await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(admission).toEqual({ kind: "failed", reason: AUTOMATIC_COMPACTION_FAILED, presentation: "provider refused" })
		expect(guard.admittedEstimate()).toBeUndefined()
	})

	it("refuses a request that cannot fit when nothing answered exists to summarize", async () => {
		estimates.push(950)
		const { guard, present } = harness({ compaction: { kind: "nothing_to_compact" } })

		const admission = await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(admission).toEqual({
			kind: "failed",
			reason: AUTOMATIC_COMPACTION_FAILED,
			presentation: NO_COMPLETE_LOGICAL_TURN,
		})
		// No run happened, so the guard writes the failure card a run would have written.
		expect(present).toHaveBeenCalledTimes(1)
		const card = present.mock.calls[0]?.[0] as { compactionId: string; attempt: string; error: string }
		expect(card.compactionId).toMatch(/^compaction:admission:/)
		expect(card.attempt).toBe(`${card.compactionId}:1`)
		expect(card.error).toBe(NO_COMPLETE_LOGICAL_TURN)
		expect(guard.admittedEstimate()).toBeUndefined()
	})

	it("sends an over-trigger request unchanged when the assembly never compacts", async () => {
		estimates.push(850)
		const { guard, present } = harness({ withCompaction: false })

		const admission = await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(admission).toEqual({ kind: "ready", environment: ENVIRONMENT })
		expect(present).not.toHaveBeenCalled()
		expect(guard.admittedEstimate()).toBe(850)
	})

	it("warns inside the request's environment once less than 10% of the window remains", async () => {
		estimates.push(950, 960)
		const { guard } = harness({ withCompaction: false })

		const admission = await guard.admit({ signal: new AbortController().signal, environment: ENVIRONMENT })

		expect(admission.kind).toBe("ready")
		const environment = admission.kind === "ready" ? admission.environment : undefined
		expect(environment).toContain("# High Context Pressure")
		expect(environment?.endsWith("</environment_details>")).toBe(true)
		expect(environment?.match(/# High Context Pressure/g)).toHaveLength(1)
		// The warning is part of what is sent, so the admitted estimate includes it.
		expect(lastText(measuredMessages[1])).toBe(environment)
		expect(guard.admittedEstimate()).toBe(960)
	})

	it("does not repeat a warning the environment already carries", async () => {
		estimates.push(950)
		const { guard } = harness({ withCompaction: false })
		const warned = ENVIRONMENT.replace("</environment_details>", "# High Context Pressure\n</environment_details>")

		const admission = await guard.admit({ signal: new AbortController().signal, environment: warned })

		expect(admission).toEqual({ kind: "ready", environment: warned })
		expect(measuredMessages).toHaveLength(1)
	})

	it("admits a request without environment details and adds none", async () => {
		estimates.push(950)
		const { guard } = harness({ withCompaction: false })

		const admission = await guard.admit({ signal: new AbortController().signal })

		expect(admission).toEqual({ kind: "ready" })
		expect(measuredMessages[0]).toEqual(HISTORY)
	})
})
