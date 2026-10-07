import { describe, expect, it, vi } from "vitest"
import type { TaskInput } from "../../shell/TaskShell"
import { ResumeDialogContinuation, type TaskResumptionPort } from "../UnownedDialogContinuation"

function resumption(): TaskResumptionPort & { readonly materialize: ReturnType<typeof vi.fn> } {
	const input: TaskInput = { entryId: "entry-1", payloadRef: "sha256:input" }
	return {
		materialize: vi.fn(async () => input),
		submit: vi.fn(async () => undefined),
	}
}

const RESTORED_SESSION = "The previous task session was closed and has now been restored."

describe("ResumeDialogContinuation", () => {
	it("submits the typed answer so the resumed task opens a new round", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		await continuation.continue({
			interactionId: "interrupted:task-1:76",
			kind: "resume",
			outcome: { actionId: "resume", draft: { text: "continue carefully", images: [], files: [] } },
		})

		const [submission] = ports.materialize.mock.calls[0] as [{ text?: string; context?: string }]
		expect(submission.text).toBe("continue carefully")
		expect(ports.submit).toHaveBeenCalledWith({ entryId: "entry-1", payloadRef: "sha256:input" })
	})

	it("hands the request a failed-round Retry opens to the user", async () => {
		const ports = resumption()
		const providerRetry = { takeOver: vi.fn(), releaseTakeover: vi.fn() }
		const continuation = new ResumeDialogContinuation(ports, undefined, providerRetry)

		await continuation.continue({
			interactionId: "error:turn-1",
			kind: "error_retry",
			outcome: { actionId: "retry", draft: { text: "", images: [], files: [] } },
		})
		await continuation.continue({
			interactionId: "interrupted:task-1:76",
			kind: "resume",
			outcome: { actionId: "resume", draft: { text: "", images: [], files: [] } },
		})

		// Only the Retry of a failed round takes the request over.
		expect(providerRetry.takeOver).toHaveBeenCalledTimes(1)
		expect(providerRetry.takeOver.mock.invocationCallOrder[0]).toBeLessThan(
			(ports.submit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
		)
		expect(providerRetry.releaseTakeover).not.toHaveBeenCalled()
	})

	it("returns the automatic sequence when the Retry never reached a request", async () => {
		const ports = resumption()
		;(ports.submit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("intake closed"))
		const providerRetry = { takeOver: vi.fn(), releaseTakeover: vi.fn() }
		const continuation = new ResumeDialogContinuation(ports, undefined, providerRetry)

		const outcome = await continuation.continue({
			interactionId: "error:turn-1",
			kind: "error_retry",
			outcome: { actionId: "retry", draft: { text: "", images: [], files: [] } },
		})

		expect(outcome).toBe("failed")
		expect(providerRetry.releaseTakeover).toHaveBeenCalledTimes(1)
	})

	it("tells the model the session was restored without putting it in the user's text", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		await continuation.continue({
			interactionId: "interrupted:task-1:76",
			kind: "resume",
			outcome: { actionId: "resume", draft: { text: "continue carefully", images: [], files: [] } },
		})

		const [submission] = ports.materialize.mock.calls[0] as [{ text?: string; context?: string }]
		expect(submission.context).toContain(RESTORED_SESSION)
		expect(submission.text).not.toContain(RESTORED_SESSION)
	})

	it("does not claim a restored session when retrying inside the live one", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		await continuation.continue({
			interactionId: "error:provider.failed:83",
			kind: "error_retry",
			outcome: { actionId: "retry", draft: { text: "try again", images: [], files: [] } },
		})

		const [submission] = ports.materialize.mock.calls[0] as [{ context?: string }]
		expect(submission.context).toBeUndefined()
		expect(ports.submit).toHaveBeenCalledOnce()
	})

	it("still resumes when the user answered without typing anything", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		await continuation.continue({ interactionId: "interrupted:task-1:76", kind: "resume", outcome: { actionId: "resume" } })

		const [submission] = ports.materialize.mock.calls[0] as [{ text?: string; context?: string }]
		expect(submission.text).toBeUndefined()
		expect(submission.context).toContain(RESTORED_SESSION)
		expect(ports.submit).toHaveBeenCalledOnce()
	})

	it("leaves the task alone when the answer was not a request to carry on", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		const outcome = await continuation.continue({
			interactionId: "interrupted:task-1:76",
			kind: "resume",
			outcome: { actionId: "start_new_task" },
		})

		expect(outcome).toBe("declined")
		expect(ports.materialize).not.toHaveBeenCalled()
		expect(ports.submit).not.toHaveBeenCalled()
	})

	// Reopening a completed task from history is the case that made this
	// necessary: the receiver that opened the completion died with the previous
	// process, so the reply the user types has nobody to hand it to. Declining
	// it discarded the message and left the task paused with no dialog, which
	// disabled the composer for good.
	it("resumes a completed task the user replied to after reopening it", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		const outcome = await continuation.continue({
			interactionId: "dline_tid_01M36YXVER4RX0PN63CDTCV2ED",
			kind: "completion",
			outcome: { actionId: "reply", draft: { text: "keep going", images: [], files: [] } },
		})

		expect(outcome).toBe("continued")
		const [submission] = ports.materialize.mock.calls[0] as [{ text?: string }]
		expect(submission.text).toBe("keep going")
		expect(ports.submit).toHaveBeenCalledOnce()
	})

	// followup/make_plan/qna_response/generate_report all answer through the
	// same `reply`, so a restored task has to carry on from any of them.
	it("resumes a handler interaction the user replied to without a receiver", async () => {
		const ports = resumption()
		const continuation = new ResumeDialogContinuation(ports)

		const outcome = await continuation.continue({
			interactionId: "dline_tid_followup",
			kind: "followup",
			outcome: { actionId: "reply", draft: { text: "option b", images: [], files: [] } },
		})

		expect(outcome).toBe("continued")
		expect(ports.submit).toHaveBeenCalledOnce()
	})

	// The task must not be left believing the answer was consumed when the
	// submission itself failed, so the failure has to be reportable.
	it("reports a failure instead of claiming the task carried on", async () => {
		const ports = resumption()
		ports.submit = vi.fn(async () => {
			throw new Error("intake refused")
		})
		const continuation = new ResumeDialogContinuation(ports)

		const outcome = await continuation.continue({
			interactionId: "dline_tid_01M36YXVER4RX0PN63CDTCV2ED",
			kind: "completion",
			outcome: { actionId: "reply", draft: { text: "keep going", images: [], files: [] } },
		})

		expect(outcome).toBe("failed")
	})
})
