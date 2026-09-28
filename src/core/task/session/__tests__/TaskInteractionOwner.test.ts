import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { isInteractionCancellationError } from "../../interaction/InteractionCancellationError"
import { createInitialTaskState, type DialogInteraction, type TaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import type { RuntimeDiagnostic } from "../../runtime"
import type { TaskPayloadStore } from "../../stores"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"
import type { UnownedDialogContinuationPort, UnownedDialogOutcome } from "../UnownedDialogContinuation"

function createMessages(rows: UiMessage[] = []): MessageStateHandler {
	return {
		clineMessages: rows,
		addToClineMessages: vi.fn(async () => undefined),
		finalizeClineMessage: vi.fn(async () => undefined),
		removeMessagesByTs: vi.fn(async (timestamps: number[]) => {
			for (const timestamp of timestamps) {
				const index = rows.findIndex((row) => row.ts === timestamp)
				if (index >= 0) rows.splice(index, 1)
			}
		}),
	} as unknown as MessageStateHandler
}

/** A dialog the kernel restored, which no receiver in this process awaits. */
function restoredPrimary(interactionId: string, kind: DialogInteraction["kind"]): TaskState {
	const state = createInitialTaskState("task-1")
	return {
		...state,
		dialog: {
			...state.dialog,
			primary: {
				interactionId,
				turnId: "turn-restored",
				kind,
				status: "awaiting",
				createdRevision: state.revision,
				presentationRef: "sha256:presentation",
				actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
				receiverGeneration: state.generation,
			},
		},
	}
}

function createOwner(options?: {
	readonly continuation?: UnownedDialogContinuationPort
	readonly state?: () => TaskState
	readonly messages?: MessageStateHandler
}): {
	owner: TaskInteractionOwner
	messages: MessageStateHandler
	submitted: string[]
	recorded: RuntimeDiagnostic[]
	/** Resolves on the next event the owner submits; arm it before causing one. */
	whenSubmitted: () => Promise<void>
} {
	const submitted: string[] = []
	const recorded: RuntimeDiagnostic[] = []
	let announce: (() => void) | undefined
	const payloads = { put: vi.fn(async () => "sha256:payload"), read: vi.fn() } as unknown as TaskPayloadStore
	const messages = options?.messages ?? createMessages()
	const owner = new TaskInteractionOwner(messages, payloads, options?.continuation, {
		record: (diagnostic) => recorded.push(diagnostic),
	})
	const session = {
		state: options?.state ?? (() => createInitialTaskState("task-1")),
		assembly: {
			runtime: {
				submit: async (event: { type: string }) => {
					submitted.push(event.type)
					announce?.()
					return { kind: "accepted" as const }
				},
			},
		},
	} as unknown as ActiveTaskSession
	owner.bind(session)
	// A request registers its receiver immediately before submitting the event,
	// so the submission is when a stop would first find something to release.
	return { owner, messages, submitted, recorded, whenSubmitted: () => new Promise<void>((resolve) => (announce = resolve)) }
}

function continuationPort(outcome: UnownedDialogOutcome): UnownedDialogContinuationPort & {
	readonly continue: ReturnType<typeof vi.fn>
} {
	return { accepts: () => outcome !== "declined", continue: vi.fn(async () => outcome) }
}

describe("TaskInteractionOwner", () => {
	it("fails a receiver whose answer a stop has made impossible", async () => {
		const { owner, whenSubmitted } = createOwner()
		const waiting = owner.open({
			turnId: "turn-1",
			interactionId: "i-1",
			kind: "completion",
			presentation: "done",
		})
		await whenSubmitted()

		owner.suspend("dialog_terminate")

		// A turn-ending tool parked here is in-flight work of the tool domain, so
		// the stop that fenced this dialog drains by waiting for it. It has to
		// fail rather than keep waiting for an answer that can no longer arrive.
		await expect(waiting).rejects.toSatisfy(isInteractionCancellationError)
	})

	it("refuses a receiver that arrives after the stop, not just the ones already waiting", async () => {
		const { owner, submitted } = createOwner()
		owner.suspend("dialog_terminate")

		// The tool was busy elsewhere when the stop ran — writing a checkpoint,
		// for instance — and asks only now. Admitting it would park it on an
		// answer the stopped domain can no longer deliver, which is exactly the
		// wait that kept the task from ever finishing its teardown.
		const late = owner.complete({
			turnId: "turn-1",
			interactionId: "i-late",
			completionId: "c-late",
			presentation: "done",
		})

		await expect(late).rejects.toSatisfy(isInteractionCancellationError)
		expect(submitted).toEqual([])
	})

	it("dismisses the active provider failure and removes its obsolete rows", async () => {
		const messages = createMessages([
			{ ts: 1, type: "say", say: "error_retry", text: '{"errorMessage":"Profile not valid"}' },
			{
				ts: 2,
				type: "ask",
				ask: "api_req_failed",
				text: "Profile not valid",
				interactionId: "i-error",
			},
		])
		const restored = restoredPrimary("i-error", "error_retry")
		const state = () => ({ ...restored, flow: { phase: "error" as const, error: "Profile not valid" } })
		const { owner, submitted } = createOwner({ messages, state })

		await owner.dismissProviderFailure()

		expect(submitted).toEqual(["dialog.dismissed"])
		expect(messages.removeMessagesByTs).toHaveBeenCalledWith([1, 2])
		expect(messages.clineMessages).toEqual([])
	})

	it("stays usable after a stop, because a cancelled task may resume", async () => {
		const { owner, submitted, whenSubmitted } = createOwner()
		const abandoned = owner.open({ turnId: "turn-1", interactionId: "i-1", kind: "followup", presentation: "ask" })
		await whenSubmitted()
		owner.suspend("dialog_cancel")
		await expect(abandoned).rejects.toSatisfy(isInteractionCancellationError)
		owner.resume()

		const reopened = owner.open({ turnId: "turn-2", interactionId: "i-2", kind: "followup", presentation: "ask again" })
		await whenSubmitted()
		const retired = whenSubmitted()
		owner.resolve("i-2", { actionId: "reply" })
		await retired

		await expect(reopened).resolves.toMatchObject({ actionId: "reply" })
		expect(submitted).toEqual(["dialog.requested", "dialog.requested", "dialog.resolved"])
	})

	// Retiring says the answer reached whoever had to act on it. When the
	// continuation carries the task on, that is true and the dialog must be
	// released so the next one can open.
	it("retires a restored dialog once the continuation carries the task on", async () => {
		const continuation = continuationPort("continued")
		const { owner, submitted } = createOwner({
			continuation,
			state: () => restoredPrimary("i-restored", "completion"),
		})

		owner.resolve("i-restored", { actionId: "reply" })
		await vi.waitFor(() =>
			expect(continuation.continue).toHaveBeenCalledWith(
				expect.objectContaining({ interactionId: "i-restored", kind: "completion" }),
			),
		)

		// Retired before the continuation ran, because the round it opens needs
		// the dialog slot the retire releases.
		expect(submitted).toEqual(["dialog.resolved"])
	})

	// Retiring a dialog nothing acted on told the kernel the answer was
	// consumed while the task stayed paused with no dialog at all, which is
	// what left the composer permanently disabled after reopening a task.
	it("keeps a restored dialog answerable when nothing carried the task on", async () => {
		const continuation = continuationPort("declined")
		const { owner, submitted, recorded } = createOwner({
			continuation,
			state: () => restoredPrimary("i-restored", "completion"),
		})

		owner.resolve("i-restored", { actionId: "start_new_task" })
		await vi.waitFor(() =>
			expect(recorded).toContainEqual(
				expect.objectContaining({ source: "dialog", code: "unowned_dialog_settled", severity: "observation" }),
			),
		)

		expect(submitted).toEqual([])
	})

	// Every unowned answer is reported, because "the task resumed" and "the
	// answer went nowhere" are otherwise indistinguishable in the log.
	it("reports how a restored dialog was settled even when the task carried on", async () => {
		const { owner, recorded } = createOwner({
			continuation: continuationPort("continued"),
			state: () => restoredPrimary("i-restored", "completion"),
		})

		owner.resolve("i-restored", { actionId: "reply" })
		await vi.waitFor(() =>
			expect(recorded).toContainEqual(
				expect.objectContaining({ code: "unowned_dialog_settled", message: expect.stringContaining("continued") }),
			),
		)
	})

	// A continuation that accepted the answer but then failed to act on it must
	// leave the question answerable, or the task is stuck with no dialog.
	it("reopens a restored dialog when the continuation accepted but failed", async () => {
		const { owner, submitted } = createOwner({
			continuation: continuationPort("failed"),
			state: () => restoredPrimary("i-restored", "completion"),
		})

		owner.resolve("i-restored", { actionId: "reply" })
		await vi.waitFor(() => expect(submitted).toEqual(["dialog.resolved", "dialog.reopened"]))
	})

	// A receiver is the one that acts on the answer, so its dialog retires on
	// delivery and never consults the continuation.
	it("retires an awaited dialog without asking the continuation", async () => {
		const continuation = continuationPort("declined")
		const { owner, submitted, whenSubmitted } = createOwner({ continuation })
		const waiting = owner.open({ turnId: "turn-1", interactionId: "i-1", kind: "followup", presentation: "ask" })
		await whenSubmitted()

		const retired = whenSubmitted()
		owner.resolve("i-1", { actionId: "reply" })
		await retired

		await expect(waiting).resolves.toMatchObject({ actionId: "reply" })
		expect(continuation.continue).not.toHaveBeenCalled()
		expect(submitted).toEqual(["dialog.requested", "dialog.resolved"])
	})
})
