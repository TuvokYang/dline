import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { LifecycleCommand, UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import {
	type AdmittedLifecycleBarrier,
	type LifecycleBarrierPort,
	SemanticInputRejectedError,
	type TaskInputAdmissionPort,
} from "../TaskInputAdmission"
import { TaskInputMaterializer } from "../TaskInputMaterializer"

const document: SemanticInputDocument = {
	schemaVersion: 1,
	parserVersion: "1.0.0",
	catalogRevision: "2",
	documentId: "doc-1",
	rawText: "/compact please",
	nodes: [{ kind: "text", text: "/compact please" }],
	resources: [],
}

function recordingPayloads() {
	const stored: Uint8Array[] = []
	const payloads = {
		put: async (payload: Uint8Array) => {
			stored.push(payload)
			return `ref-${stored.length}`
		},
		read: async () => undefined,
	} as unknown as TaskPayloadStore
	return {
		payloads,
		lastEnvelope: () => decodeTaskPayload<UserInputEnvelope>(stored[stored.length - 1]),
	}
}

const identity = { nextEntryId: () => "entry-1", nextSequence: () => 0 }

const admitting: TaskInputAdmissionPort = {
	admit: async () => ({
		ok: true,
		admitted: {
			document,
			admittedText: "<compact-instructions> please",
			authorizedTools: ["summarize_task"],
			explicitInstructions: [{ type: "summarize_task", source: "manual_compact_command" }],
		},
	}),
}

const compactBarrier: AdmittedLifecycleBarrier = {
	commandId: "command.compact",
	before: "<explain-instructions> then",
	sourceBefore: "/explain then",
	premessage: "keep the audit",
	instructionsBefore: [{ type: "skill", source: "skill_injection" }],
	toolsBefore: ["use_skill"],
}

const admittingBarrier: TaskInputAdmissionPort = {
	admit: async () => ({
		ok: true,
		admitted: {
			document,
			admittedText: "<explain-instructions> then <compact-instructions> keep the audit",
			authorizedTools: ["use_skill", "summarize_task"],
			explicitInstructions: [
				{ type: "skill", source: "skill_injection" },
				{ type: "summarize_task", source: "manual_compact_command" },
			],
			barrier: compactBarrier,
		},
	}),
}

function recordingBarriers(owns: boolean) {
	const requested: LifecycleCommand[] = []
	const port: LifecycleBarrierPort = {
		owns: () => owns,
		request: (command) => {
			requested.push(command)
		},
	}
	return { port, requested }
}

const refusing: TaskInputAdmissionPort = {
	admit: async () => ({
		ok: false,
		diagnostics: [{ code: "semantic_input_catalog_stale", message: "stale", documentId: "doc-1" }],
	}),
}

describe("TaskInputMaterializer", () => {
	it("stores the raw text, the document and the admitted projection side by side", async () => {
		const store = recordingPayloads()
		const materializer = new TaskInputMaterializer(store.payloads, identity, admitting)

		await materializer.materialize({ text: "/compact please" })

		const envelope = store.lastEnvelope()
		expect(envelope.text).toBe("/compact please")
		expect(envelope.admittedText).toBe("<compact-instructions> please")
		expect(envelope.semanticInput?.documentId).toBe("doc-1")
		expect(envelope.authorizedTools).toEqual(["summarize_task"])
		expect(envelope.explicitInstructions).toEqual([{ type: "summarize_task", source: "manual_compact_command" }])
	})

	it("refuses a rejected submission instead of journaling it", async () => {
		const store = recordingPayloads()
		const materializer = new TaskInputMaterializer(store.payloads, identity, refusing)

		await expect(materializer.materialize({ text: "/compact" })).rejects.toBeInstanceOf(SemanticInputRejectedError)
	})

	it("stays a plain materializer when no admission is configured", async () => {
		const store = recordingPayloads()
		const materializer = new TaskInputMaterializer(store.payloads, identity)

		const input = await materializer.materialize({ text: "hello" }, "steering")

		expect(input.mode).toBe("steering")
		const envelope = store.lastEnvelope()
		expect(envelope.text).toBe("hello")
		expect(envelope.admittedText).toBeUndefined()
	})

	it("takes an owned barrier out of the turn and carries it with the input instead", async () => {
		const store = recordingPayloads()
		const barriers = recordingBarriers(true)
		const materializer = new TaskInputMaterializer(store.payloads, identity, admittingBarrier, barriers.port)

		await materializer.materialize({ text: "/explain then /compact keep the audit" })

		const envelope = store.lastEnvelope()
		expect(envelope.text).toBe("/explain then /compact keep the audit")
		expect(envelope.admittedText).toBe("<explain-instructions> then")
		expect(envelope.explicitInstructions).toEqual([{ type: "skill", source: "skill_injection" }])
		expect(envelope.authorizedTools).toEqual(["use_skill"])
		expect(envelope.lifecycle).toEqual({ commandId: "command.compact", premessage: "keep the audit" })
		// Materializing is not acceptance: nothing acts until a round admits the input.
		expect(barriers.requested).toEqual([])
	})

	it("keeps an unowned barrier as ordinary content", async () => {
		const store = recordingPayloads()
		const materializer = new TaskInputMaterializer(store.payloads, identity, admittingBarrier, recordingBarriers(false).port)

		await materializer.materialize({ text: "/explain then /compact keep the audit" })

		const envelope = store.lastEnvelope()
		expect(envelope.admittedText).toBe("<explain-instructions> then <compact-instructions> keep the audit")
		expect(envelope.authorizedTools).toEqual(["use_skill", "summarize_task"])
		expect(envelope.explicitInstructions).toHaveLength(2)
		expect(envelope.lifecycle).toBeUndefined()
	})

	describe("reviewReply", () => {
		it("keeps what the user typed before the command and acts only once committed", async () => {
			const barriers = recordingBarriers(true)
			const materializer = new TaskInputMaterializer(
				recordingPayloads().payloads,
				identity,
				admittingBarrier,
				barriers.port,
			)

			const reviewed = await materializer.reviewReply({ text: "/explain then /compact keep the audit" })

			// A reply grants no command authority, so the typed form is kept, not its expansion.
			expect(reviewed?.text).toBe("/explain then")
			expect(barriers.requested).toEqual([])
			reviewed?.commit()
			expect(barriers.requested).toEqual([{ commandId: "command.compact", premessage: "keep the audit" }])
		})

		it("leaves the reply as typed when no domain owns the barrier", async () => {
			const materializer = new TaskInputMaterializer(
				recordingPayloads().payloads,
				identity,
				admittingBarrier,
				recordingBarriers(false).port,
			)

			expect(await materializer.reviewReply({ text: "/compact keep the audit" })).toBeUndefined()
		})

		it("keeps a refused reply literal instead of dropping the user's answer", async () => {
			const barriers = recordingBarriers(true)
			const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, refusing, barriers.port)

			expect(await materializer.reviewReply({ text: "/compact" })).toBeUndefined()
			expect(barriers.requested).toEqual([])
		})

		it("reviews nothing in an assembly without a barrier owner", async () => {
			let admitted = 0
			const counting: TaskInputAdmissionPort = {
				admit: async (input) => {
					admitted++
					return admittingBarrier.admit(input)
				},
			}
			const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, counting)

			expect(await materializer.reviewReply({ text: "/compact" })).toBeUndefined()
			expect(admitted).toBe(0)
		})
	})
})
