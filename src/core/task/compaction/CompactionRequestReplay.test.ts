import { OutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { CompactionRequestReplay } from "./CompactionRequestReplay"

const declaration = {
	type: "summarize_task" as const,
	source: "auto_compaction" as const,
	targetTool: ClineDefaultTool.SUMMARIZE_TASK,
	operationId: "operation-rolling",
}

const passIdentity = {
	operationId: "operation-rolling",
	passIndex: 2,
	passStartTurnIndex: 2,
	passEndTurnIndex: 3,
	coveredTurnCount: 2,
	summaryBaselineHash: "sha256:summary-baseline",
}

function createProviderInput(summaryMarker: string, providerOutputCap = 30_000) {
	return {
		systemPrompt: "system prompt",
		messages: [{ role: "user" as const, content: [{ type: "text" as const, text: summaryMarker }] }],
		tools: [
			{
				type: "function" as const,
				function: {
					name: "attempt_completion",
					description: "Complete the task",
					parameters: { type: "object", properties: {} },
				},
			},
		],
		serverTools: [ServerTool.WEB_SEARCH],
		providerOutputCap,
	}
}

describe("CompactionRequestReplay", () => {
	it("locks the first provider input and returns detached copies", () => {
		const replay = new CompactionRequestReplay()
		replay.begin(4, 3, 2, declaration, passIdentity)
		const first = createProviderInput("original compaction request")
		const captured = replay.captureProviderInput(4, first)

		first.systemPrompt = "mutated source"
		const firstContent = first.messages[0]?.content
		const capturedContent = captured.messages[0]?.content
		const firstText = Array.isArray(firstContent) ? firstContent[0] : undefined
		const capturedText = Array.isArray(capturedContent) ? capturedContent[0] : undefined
		if (firstText?.type !== "text" || capturedText?.type !== "text") {
			throw new Error("Expected text-backed compaction messages")
		}
		firstText.text = "mutated source message"
		capturedText.text = "mutated returned message"

		const replacement = createProviderInput("later dynamic request")
		replay.captureProviderInput(4, replacement)

		expect(replay.getProviderInput(4)).toEqual(createProviderInput("original compaction request"))
	})

	it("isolates replay state by API index and preserves the physical history boundary", () => {
		const replay = new CompactionRequestReplay()
		replay.begin(7, 5, 1, declaration, passIdentity)
		replay.captureProviderInput(7, createProviderInput("request seven"))

		expect(replay.getProviderInput(6)).toBeUndefined()
		expect(replay.getDeclaration(6)).toBeUndefined()
		expect(replay.getHistoryIndex(6)).toBeUndefined()
		expect(replay.getHistoryIndex(7)).toBe(5)
		expect(replay.getInitialConsecutiveMistakeCount(7)).toBe(1)
		replay.clear(6)
		expect(replay.getProviderInput(7)).toBeDefined()
		replay.clear(7)
		expect(replay.getProviderInput(7)).toBeUndefined()
		expect(replay.getHistoryIndex(7)).toBeUndefined()
	})

	it("returns a detached authorization declaration for persisted request replay", () => {
		const replay = new CompactionRequestReplay()
		replay.begin(9, 4, 3, { ...declaration, metadata: { origin: "pressure" } }, passIdentity)

		const first = replay.getDeclaration(9)
		expect(first).toEqual({ ...declaration, metadata: { origin: "pressure" } })
		if (first?.metadata) {
			;(first.metadata as Record<string, string>).origin = "mutated"
		}
		expect(replay.getDeclaration(9)).toEqual({ ...declaration, metadata: { origin: "pressure" } })
	})

	it("keeps the frozen cap for ordinary and Anthropic failures", () => {
		const replay = new CompactionRequestReplay()
		replay.begin(10, 6, 0, declaration, passIdentity)
		replay.captureProviderInput(10, createProviderInput("canonical request"))

		expect(replay.prepareOpenAiMaxOutputReplay(10, new Error("network failure"))).toBe("not_applicable")
		expect(replay.prepareOpenAiMaxOutputReplay(10, new OutputLimitExceededError("anthropic_messages", "max_tokens"))).toBe(
			"not_applicable",
		)
		expect(replay.getProviderInput(10)).toEqual(createProviderInput("canonical request"))
	})

	it.each([
		new OutputLimitExceededError("openai_chat", "length"),
		new OutputLimitExceededError("openai_responses", "max_output_tokens"),
	])("reduces the first OpenAI max-output replay cap by ten percent and only once", (error) => {
		const replay = new CompactionRequestReplay()
		replay.begin(11, 7, 0, declaration, passIdentity)
		replay.captureProviderInput(11, createProviderInput("canonical request", 29_999))

		expect(replay.prepareOpenAiMaxOutputReplay(11, error)).toBe("replay")
		expect(replay.getProviderInput(11)).toEqual(createProviderInput("canonical request", 26_999))
		expect(replay.prepareOpenAiMaxOutputReplay(11, error)).toBe("exhausted")
		expect(replay.getProviderInput(11)).toEqual(createProviderInput("canonical request", 26_999))
	})

	it("increments attempt identity while preserving the Pass contract and frozen semantic input hash", () => {
		const replay = new CompactionRequestReplay()
		replay.begin(12, 8, 4, declaration, passIdentity)
		replay.captureProviderInput(12, createProviderInput("canonical request", 29_999))

		const first = replay.beginAttempt(12, "authorization-attempt-0")
		expect(first).toMatchObject({
			...passIdentity,
			attemptIndex: 0,
			authorizationAttemptId: "authorization-attempt-0",
		})
		expect(first.inputHash).toMatch(/^sha256:/)

		expect(
			replay.prepareOpenAiMaxOutputReplay(12, new OutputLimitExceededError("openai_responses", "max_output_tokens")),
		).toBe("replay")
		const second = replay.beginAttempt(12, "authorization-attempt-1")
		expect(second).toMatchObject({
			...passIdentity,
			attemptIndex: 1,
			authorizationAttemptId: "authorization-attempt-1",
			inputHash: first.inputHash,
		})
		expect(replay.isCurrentAttempt(12, first)).toBe(false)
		expect(replay.isCurrentAttempt(12, second)).toBe(true)
	})

	it("rejects provider input capture outside the active request", () => {
		const replay = new CompactionRequestReplay()
		replay.begin(2, 1, 0, declaration, passIdentity)

		expect(() => replay.captureProviderInput(3, createProviderInput("wrong request"))).toThrow(
			"Compaction replay is not active for apiIndex=3",
		)
	})
})
