import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("retained compose async ownership fences", () => {
	it("does not start an intake append after cancellation during retained payload materialization", async () => {
		const payloads = new InMemoryTaskPayloadStore()
		const journal = new InMemoryConversationJournal()
		const payloadRef = await payloads.put(
			encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", text: "CANCELLED_STEERING" }),
		)
		const initial = createInitialTaskState("task-1")
		const state: TaskState = {
			...initial,
			flow: { phase: "running" },
			intake: {
				...initial.intake,
				queued: [
					{
						entryId: "entry-1",
						payloadRef,
						source: "user",
						mode: "steering",
						sequence: 0,
						state: "reserved",
						queue: {
							editing: false,
							delivery: { deliveryId: "delivery-1", ownerId: "compose-1", point: "tool_round", generation: 0 },
						},
					},
				],
			},
		}
		const entered = deferred()
		const gate = deferred()
		const put = payloads.put.bind(payloads)
		vi.spyOn(payloads, "put").mockImplementation(async (bytes) => {
			const payload = decodeTaskPayload<UserInputEnvelope>(bytes)
			if (payload.kind === "user_input" && payload.admittedText) {
				entered.resolve()
				await gate.promise
			}
			return put(bytes)
		})
		const controller = new AbortController()
		const adapter = new ProductionComposeAdapter({ payloads, journal, readState: () => state })
		const pending = adapter.compose({
			signal: controller.signal,
			admittedEntryIds: ["entry-1"],
			queueDelivery: state.intake.queued[0].queue!.delivery,
		})
		const rejected = expect(pending).rejects.toBe("cancel during payload write")
		await entered.promise
		controller.abort("cancel during payload write")
		gate.resolve()
		await rejected
		expect(await journal.read()).toEqual([])
	})
})
