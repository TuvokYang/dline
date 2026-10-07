import { OutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import type { CompactionSummaryFailureKind } from "@shared/context-compaction-failure"
import { describe, expect, it } from "vitest"
import {
	CompactionAuthorizationError,
	CompactionSummaryRejectedError,
	classifyCompactionFailure,
	isCorrectableCompactionFailure,
	renderCompactionRetryReminder,
	toReminderKind,
	withCompactionRetryReminder,
} from "../compaction-attempt-failure"

const SUMMARY_FAILURE_KINDS: CompactionSummaryFailureKind[] = [
	"empty_response",
	"missing_block",
	"foreign_tool_call",
	"missing_context",
	"empty_context",
	"unclosed_context",
	"unclosed_block",
	"output_limit",
]

function frozenInput(instruction: CompactionProviderInput["messages"][number]["content"]): CompactionProviderInput {
	return {
		systemPrompt: "system",
		messages: [
			{ role: "user", content: "earlier turn" },
			{ role: "user", content: instruction },
		] as CompactionProviderInput["messages"],
		serverTools: [],
	}
}

function textBlocks(input: CompactionProviderInput): string[] {
	const content = input.messages.at(-1)?.content
	if (typeof content === "string") return [content]
	return (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : []))
}

describe("classifyCompactionFailure", () => {
	it.each([
		{ name: "a rejected summary", error: new CompactionSummaryRejectedError("unclosed_block"), kind: "unclosed_block" },
		{
			name: "a refused authorization",
			error: new CompactionAuthorizationError("scope_closed"),
			kind: "authorization_failed",
		},
		{ name: "a Provider output limit", error: new OutputLimitExceededError("openai_chat", "length"), kind: "output_limit" },
		{ name: "an abort", error: Object.assign(new Error("stop"), { name: "AbortError" }), kind: "cancelled" },
		{ name: "a cancelled request", error: new Error("Request was cancelled by the user"), kind: "cancelled" },
		{ name: "a Provider failure", error: new Error("503 Service Unavailable"), kind: "provider_error" },
	])("maps $name to $kind", ({ error, kind }) => {
		expect(classifyCompactionFailure(error)).toBe(kind)
	})

	it("retries only model-side reply problems", () => {
		expect(isCorrectableCompactionFailure(new CompactionSummaryRejectedError("missing_block"))).toBe(true)
		expect(isCorrectableCompactionFailure(new OutputLimitExceededError("anthropic_messages", "max_tokens"))).toBe(true)
		expect(isCorrectableCompactionFailure(new CompactionAuthorizationError("scope_closed"))).toBe(false)
		expect(isCorrectableCompactionFailure(new Error("socket hang up"))).toBe(false)
		expect(isCorrectableCompactionFailure(Object.assign(new Error("stop"), { name: "AbortError" }))).toBe(false)
	})

	it("narrows only summary failure kinds to reminder kinds", () => {
		for (const kind of SUMMARY_FAILURE_KINDS) expect(toReminderKind(kind)).toBe(kind)
		expect(toReminderKind("provider_error")).toBeUndefined()
		expect(toReminderKind("authorization_failed")).toBeUndefined()
		expect(toReminderKind("cancelled")).toBeUndefined()
	})
})

describe("compaction retry reminder", () => {
	it("renders a distinct reminder for every summary failure kind", () => {
		const reminders = SUMMARY_FAILURE_KINDS.map(renderCompactionRetryReminder)

		for (const reminder of reminders) expect(reminder.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2)
		expect(new Set(reminders).size).toBe(SUMMARY_FAILURE_KINDS.length)
	})

	it("appends the reminder to the final instruction message without touching the frozen input", () => {
		const frozen = frozenInput([{ type: "text", text: "Summarize the task." }])

		const reminded = withCompactionRetryReminder(frozen, "unclosed_block")

		expect(textBlocks(reminded)).toEqual(["Summarize the task.", renderCompactionRetryReminder("unclosed_block")])
		expect(textBlocks(frozen)).toEqual(["Summarize the task."])
		expect(reminded.messages[0]).toEqual(frozen.messages[0])
		expect(reminded.systemPrompt).toBe(frozen.systemPrompt)
	})

	it("converts a string instruction into text blocks", () => {
		const reminded = withCompactionRetryReminder(frozenInput("Summarize the task."), "missing_block")

		expect(textBlocks(reminded)).toEqual(["Summarize the task.", renderCompactionRetryReminder("missing_block")])
	})

	it("replaces the previous reminder because every retry starts from the frozen input", () => {
		const frozen = frozenInput([{ type: "text", text: "Summarize the task." }])
		withCompactionRetryReminder(frozen, "unclosed_context")

		const second = withCompactionRetryReminder(frozen, "output_limit")

		expect(textBlocks(second)).toEqual(["Summarize the task.", renderCompactionRetryReminder("output_limit")])
	})
})
