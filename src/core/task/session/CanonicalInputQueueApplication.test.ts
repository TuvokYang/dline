import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskEvent, type TaskState, transition } from "../kernel"
import type { EventSubmissionResult, RuntimeFacade } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { CanonicalInputQueueApplication } from "./CanonicalInputQueueApplication"
import type { CanonicalQueueTurnEndPort } from "./InputQueueApplicationPort"
import type { TaskInputAdmissionPort } from "./TaskInputAdmission"
import { TaskInputMaterializer } from "./TaskInputMaterializer"

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((accepted, refused) => {
		resolve = accepted
		reject = refused
	})
	return { promise, resolve, reject }
}

const admittingPlainText: TaskInputAdmissionPort = {
	admit: async (input) => ({
		ok: true,
		admitted: {
			document: {
				schemaVersion: 1,
				parserVersion: "test",
				catalogRevision: "test",
				documentId: "test-input",
				rawText: input.text ?? "",
				nodes: [{ kind: "text", text: input.text ?? "" }],
				resources: [],
			},
			admittedText: input.text ?? "",
			authorizedTools: [],
			explicitInstructions: [],
		},
	}),
}

function harness(deliveryResult: "accepted" | "stale" | "failed" | "uncertain" = "accepted") {
	let state: TaskState = {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		dialog: {
			approvalsByBlock: {},
			primary: {
				interactionId: "interaction-1",
				turnId: "turn-1",
				kind: "completion",
				status: "awaiting",
				createdRevision: 0,
				presentationRef: "presentation:1",
				receiverGeneration: 0,
				actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
			},
		},
	}
	const bytes = new Map<string, Uint8Array>()
	let payloadSequence = 0
	const payloads: TaskPayloadStore = {
		put: vi.fn(async (payload) => {
			const ref = `payload:${++payloadSequence}`
			bytes.set(ref, payload)
			return ref
		}),
		read: vi.fn(async (ref) => {
			const payload = bytes.get(ref)
			if (!payload) throw new Error(`missing ${ref}`)
			return payload
		}),
	}
	const durable = deferred()
	const eventGates = new Map<TaskEvent["type"], ReturnType<typeof deferred>>()
	const gateFor = (type: TaskEvent["type"]) => {
		const gate = deferred()
		eventGates.set(type, gate)
		return gate
	}
	const runtime: RuntimeFacade = {
		getState: () => state,
		submit: vi.fn(async (event: TaskEvent): Promise<EventSubmissionResult> => {
			const result = transition(state, event)
			if (result.kind === "rejected") return result
			state = result.state
			return { ...result, receipt: { revision: state.revision, durable: (eventGates.get(event.type) ?? durable).promise } }
		}),
		projectTransient: vi.fn(),
		waitForDurable: vi.fn(),
		waitForDomainCompletion: vi.fn(),
		waitForQuiescence: vi.fn(),
		releaseRestoredCommands: vi.fn(),
	}
	let entrySequence = 0
	const inputs = new TaskInputMaterializer(
		payloads,
		{
			nextEntryId: () => `entry-${++entrySequence}`,
			nextSequence: () => entrySequence,
		},
		admittingPlainText,
	)
	const deliverTurnEnd = vi.fn<CanonicalQueueTurnEndPort["deliverTurnEnd"]>(async () => deliveryResult)
	return {
		application: new CanonicalInputQueueApplication(runtime, inputs, payloads, { deliverTurnEnd }),
		deliverTurnEnd,
		durable,
		runtime,
		payloads,
		gateFor,
	}
}

describe("CanonicalInputQueueApplication", () => {
	it("reports enqueue success only after the canonical state is durable", async () => {
		const { application, durable } = harness()
		let settled = false
		const mutation = application
			.mutate({ kind: "enqueue", draft: { text: "queue me", images: [], files: [] } })
			.then((result) => {
				settled = true
				return result
			})

		await Promise.resolve()
		expect(settled).toBe(false)
		durable.resolve()
		await expect(mutation).resolves.toEqual({ accepted: true, result: "entry-1" })
		await expect(application.project()).resolves.toEqual([
			expect.objectContaining({ id: "entry-1", text: "queue me", mode: "queued", editing: false }),
		])
	})

	it("maps durable failures and retains transport-compatible mutation outcomes", async () => {
		const failed = harness()
		const enqueue = failed.application.mutate({ kind: "enqueue", draft: { text: "queue me", images: [], files: [] } })
		failed.durable.reject(new Error("disk full"))
		await expect(enqueue).resolves.toEqual({ accepted: false, result: "persist_failed" })

		const toggled = harness()
		const created = toggled.application.mutate({ kind: "enqueue", draft: { text: "queue me", images: [], files: [] } })
		toggled.durable.resolve()
		await created
		await expect(toggled.application.mutate({ kind: "toggle_mode", entryId: "entry-1" })).resolves.toEqual({
			accepted: true,
			result: "steering",
		})
	})

	it("materializes internal model guidance separately from the delivered user row", async () => {
		const h = harness()
		const enqueue = h.application.mutate({
			kind: "enqueue",
			draft: { text: "## queued heading", images: ["image.png"], files: ["notes.md"] },
		})
		h.durable.resolve()
		await enqueue

		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.deliverTurnEnd).toHaveBeenCalledOnce())

		const delivery = h.deliverTurnEnd.mock.calls[0]?.[0]
		expect(delivery).toMatchObject({
			deliveryId: "queue:turn_end:interaction-1",
			mode: "queued",
			modelDraft: { images: ["image.png"], files: ["notes.md"] },
			presentationDraft: { text: "## queued heading", images: ["image.png"], files: ["notes.md"] },
		})
		expect(delivery?.modelDraft.text).toContain("queued heading")
		expect(delivery?.modelDraft.text).toContain("sent by the user while work was in progress")
		expect(delivery?.presentationDraft.text).not.toContain("sent by the user while work was in progress")
	})

	it("wraps a steering batch with one shared instruction and one ordered message block per entry", async () => {
		const h = harness()
		h.durable.resolve()
		for (const text of ["BATCH_FIRST", "BATCH_SECOND"]) {
			const created = await h.application.mutate({ kind: "enqueue", draft: { text, images: [], files: [] } })
			if (!created.accepted) throw new Error("Enqueue failed")
			await h.application.mutate({ kind: "toggle_mode", entryId: created.result })
		}
		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.deliverTurnEnd).toHaveBeenCalledOnce())
		const batch = h.deliverTurnEnd.mock.calls[0][0]
		expect(batch.entries.map((entry) => entry.entryId)).toEqual(["entry-1", "entry-2"])
		expect(batch.modelDraft.text.match(/sent by the user while work was in progress/g)).toHaveLength(1)
		expect(batch.modelDraft.text.match(/<user_message>/g)).toHaveLength(2)
		expect(batch.modelDraft.text.indexOf("BATCH_FIRST")).toBeLessThan(batch.modelDraft.text.indexOf("BATCH_SECOND"))
		expect(batch.presentationDraft.text).toBe("BATCH_FIRST\n\nBATCH_SECOND")
	})

	it("does not materialize or deliver before its own reservation receipt becomes durable", async () => {
		const h = harness()
		h.durable.resolve()
		await h.application.mutate({ kind: "enqueue", draft: { text: "receipt owned", images: [], files: [] } })
		const gate = h.gateFor("input_queue.delivery_reserved")
		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.runtime.getState().intake.queued[0]?.state).toBe("reserved"))
		expect(h.deliverTurnEnd).not.toHaveBeenCalled()
		expect(h.payloads.read).not.toHaveBeenCalled()
		gate.resolve()
		await vi.waitFor(() => expect(h.deliverTurnEnd).toHaveBeenCalledOnce())
	})

	it("never locally rolls back or sends a reservation whose durable receipt failed", async () => {
		const h = harness()
		h.durable.resolve()
		await h.application.mutate({ kind: "enqueue", draft: { text: "withheld", images: [], files: [] } })
		const gate = h.gateFor("input_queue.delivery_reserved")
		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.runtime.getState().intake.queued[0]?.state).toBe("reserved"))
		gate.reject(new Error("reservation write failed"))
		await vi.waitFor(() => expect(h.runtime.submit).toHaveBeenCalledTimes(2))
		expect(h.deliverTurnEnd).not.toHaveBeenCalled()
		expect(h.runtime.getState().intake.queued[0]?.state).toBe("reserved")
	})

	it.each([
		"payload",
		"receiver",
	] as const)("releases a pre-response %s exception through the canonical event", async (stage) => {
		const h = harness()
		h.durable.resolve()
		await h.application.mutate({ kind: "enqueue", draft: { text: "recover me", images: [], files: [] } })
		if (stage === "payload") vi.mocked(h.payloads.read).mockRejectedValueOnce(new Error("payload read failed"))
		else h.deliverTurnEnd.mockRejectedValueOnce(new Error("receiver failed"))
		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() =>
			expect(h.runtime.submit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "input_queue.delivery_released", generation: 0 }),
			),
		)
		expect(h.runtime.getState().intake.queued[0]?.state).toBe("released")
		await expect(h.application.project()).resolves.toEqual([expect.objectContaining({ text: "recover me" })])
	})

	it("does not release or retry a response whose durable outcome is unknown", async () => {
		const h = harness("uncertain")
		h.durable.resolve()
		await h.application.mutate({ kind: "enqueue", draft: { text: "not twice", images: [], files: [] } })
		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.deliverTurnEnd).toHaveBeenCalledOnce())
		await h.application.mutate({ kind: "enqueue", draft: { text: "next", images: [], files: [] } })
		expect(h.deliverTurnEnd).toHaveBeenCalledOnce()
		expect(
			vi
				.mocked(h.runtime.submit)
				.mock.calls.flat()
				.some((event) => event.type === "input_queue.delivery_released"),
		).toBe(false)
	})

	it("uses the reservation generation when releasing a late exception after cancel", async () => {
		const h = harness()
		h.durable.resolve()
		await h.application.mutate({ kind: "enqueue", draft: { text: "cancel me", images: [], files: [] } })
		const gate = deferred()
		vi.mocked(h.payloads.read).mockImplementationOnce(async () => {
			await gate.promise
			throw new Error("late read failure")
		})
		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.payloads.read).toHaveBeenCalledOnce())
		await h.runtime.submit({ type: "user.cancel", generation: 0, haltId: "cancel-1" })
		gate.resolve()
		await vi.waitFor(() =>
			expect(h.runtime.submit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "input_queue.delivery_released", generation: 0 }),
			),
		)
		expect(h.runtime.getState().generation).toBe(1)
		expect(h.deliverTurnEnd).not.toHaveBeenCalled()
	})

	it("releases a reservation when the causal dialog response fails", async () => {
		const h = harness("failed")
		const enqueue = h.application.mutate({ kind: "enqueue", draft: { text: "try later", images: [], files: [] } })
		h.durable.resolve()
		await enqueue

		h.application.onTurnEndAwaiting({ turnId: "turn-1", interactionId: "interaction-1", kind: "completion" })
		await vi.waitFor(() => expect(h.deliverTurnEnd).toHaveBeenCalledOnce())
		await vi.waitFor(async () => {
			await expect(h.application.project()).resolves.toEqual([
				expect.objectContaining({ id: "entry-1", text: "try later" }),
			])
		})
	})
})
