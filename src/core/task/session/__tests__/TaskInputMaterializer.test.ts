import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { SemanticInputRejectedError, type TaskInputAdmissionPort } from "../TaskInputAdmission"
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
})
