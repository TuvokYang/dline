import { describe, expect, it, vi } from "vitest"
import type { TaskState } from "../../kernel"
import type { TaskInput } from "../../shell/TaskShell"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope, ToolResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import {
	RestoredToolDialogContinuation,
	type RestoredToolDialogPorts,
	selectedFollowupOption,
} from "../RestoredToolDialogContinuation"
import type { UnownedDialogContinuationPort } from "../UnownedDialogContinuation"

const TID = "tid-restored"

function invocation(toolName: string): ToolInvocationEnvelope {
	return {
		kind: "tool_invocation",
		toolName,
		input: {},
		functionId: "call_restored",
		dlineTid: TID,
		presentationId: 1,
		isNativeToolCall: true,
	}
}

function harness(options: { readonly toolName: string; readonly phase?: string; readonly askText?: string }) {
	const stored = new Map<string, unknown>([["ref:invocation", encodeTaskPayload(invocation(options.toolName))]])
	const puts: unknown[] = []
	const payloads = {
		read: vi.fn(async (ref: string) => stored.get(ref)),
		put: vi.fn(async (encoded: unknown) => {
			puts.push(encoded)
			return `ref:put-${puts.length}`
		}),
	} as unknown as RestoredToolDialogPorts["payloads"]
	const journal = { append: vi.fn(async () => ({ watermark: { seq: 9 }, disposition: "appended" as const })) }
	const clineMessages = [{ ts: 1, type: "ask", ask: "followup", interactionId: TID, text: options.askText }]
	const messages = {
		clineMessages,
		addToClineMessages: vi.fn(async () => undefined),
		updateClineMessage: vi.fn(async () => undefined),
		flushMessageUpdate: vi.fn(async () => undefined),
	} as unknown as RestoredToolDialogPorts["messages"]
	const state = {
		turn: {
			turnId: "turn-1",
			blocks: [{ blockId: TID, phase: options.phase ?? "cancelled", invocationRef: "ref:invocation" }],
		},
	} as unknown as TaskState
	const input: TaskInput = { entryId: "entry-1", payloadRef: "sha256:input" }
	const resumption = { materialize: vi.fn(async () => input), submit: vi.fn(async () => undefined) }
	const fallback: UnownedDialogContinuationPort & { readonly continue: ReturnType<typeof vi.fn> } = {
		accepts: vi.fn(() => false),
		continue: vi.fn(async () => "declined" as const),
	}
	const publishRow = vi.fn(async () => undefined)
	const continuation = new RestoredToolDialogContinuation(
		{ state: () => state, payloads, journal, messages, nextPresentationId: () => 100, publishRow },
		resumption,
		fallback,
	)
	const journaledResult = () => decodeTaskPayload<ToolResultEnvelope>(puts.at(-1) as never)
	return { continuation, journal, messages, resumption, fallback, journaledResult, publishRow }
}

describe("RestoredToolDialogContinuation", () => {
	it("records a restored follow-up answer as the tool's result and resumes once", async () => {
		const question = { question: "Which one?", options: ["OPTION_A", "OPTION_B"] }
		const h = harness({ toolName: "ask_followup_question", askText: JSON.stringify(question) })
		const resolution = {
			interactionId: TID,
			kind: "followup",
			outcome: { actionId: "reply" as const, draft: { text: "OPTION_B: DRAFT_NOTE", images: [], files: [] } },
		}

		expect(h.continuation.accepts(resolution)).toBe(true)
		await expect(h.continuation.continue(resolution)).resolves.toBe("continued")

		const result = h.journaledResult()
		expect(result).toMatchObject({ kind: "tool_result", blockId: TID })
		expect(result.content).toContain("OPTION_B: DRAFT_NOTE")
		expect(result.content).toContain("call_restored")
		expect(h.journal.append).toHaveBeenCalledWith(
			expect.objectContaining({ operationId: `tool.restored_result:turn-1:${TID}`, source: "tool" }),
		)
		expect(h.messages.updateClineMessage).toHaveBeenCalledWith(0, {
			text: JSON.stringify({ ...question, selected: "OPTION_B" }),
		})
		// The ask row is already on screen, so the picked option has to be pushed.
		expect(h.publishRow).toHaveBeenCalledWith(expect.objectContaining({ ts: 1, interactionId: TID }))
		expect(h.messages.addToClineMessages).toHaveBeenCalledWith(
			expect.objectContaining({ say: "user_feedback", text: "OPTION_B: DRAFT_NOTE" }),
		)
		expect(h.resumption.materialize).toHaveBeenCalledWith({})
		expect(h.resumption.submit).toHaveBeenCalledOnce()
		expect(h.fallback.continue).not.toHaveBeenCalled()
	})

	it("answers a restored status Stop as the tool would instead of declining it", async () => {
		const h = harness({ toolName: "status_update" })
		const resolution = {
			interactionId: TID,
			kind: "status_acknowledgment",
			outcome: { actionId: "stop" as const, draft: { text: "STOP_DRAFT", images: [], files: [] } },
		}

		expect(h.continuation.accepts(resolution)).toBe(true)
		await expect(h.continuation.continue(resolution)).resolves.toBe("continued")

		expect(h.journaledResult().content).toContain("User chose to stop")
		expect(h.journaledResult().content).toContain("STOP_DRAFT")
	})

	it("keeps the acknowledgment wording for Acknowledge", async () => {
		const h = harness({ toolName: "status_update" })
		await h.continuation.continue({
			interactionId: TID,
			kind: "status_acknowledgment",
			outcome: { actionId: "acknowledge" as never, draft: { text: "ACK_DRAFT", images: [], files: [] } },
		})

		expect(h.journaledResult().content).toContain("User acknowledged")
		expect(h.journaledResult().content).toContain("ACK_DRAFT")
	})

	it("leaves dialogs that no restored tool block owns to the generic resume path", async () => {
		const live = harness({ toolName: "ask_followup_question", phase: "executing" })
		const resume = { interactionId: TID, kind: "followup", outcome: { actionId: "reply" as const } }
		await live.continuation.continue(resume)
		expect(live.fallback.continue).toHaveBeenCalledWith(resume)
		expect(live.journal.append).not.toHaveBeenCalled()

		const recovery = harness({ toolName: "ask_followup_question" })
		const interrupted = { interactionId: "interrupted:task:1", kind: "resume", outcome: { actionId: "resume" as const } }
		await recovery.continuation.continue(interrupted)
		expect(recovery.fallback.continue).toHaveBeenCalledWith(interrupted)
		expect(recovery.journal.append).not.toHaveBeenCalled()
	})

	it("matches an option only as the whole answer or its prefix", () => {
		const options = ["A", "A long"]
		expect(selectedFollowupOption(options, "A")).toBe("A")
		expect(selectedFollowupOption(options, "A long: note")).toBe("A long")
		expect(selectedFollowupOption(options, "Another")).toBeUndefined()
		expect(selectedFollowupOption(options, undefined)).toBeUndefined()
	})
})
