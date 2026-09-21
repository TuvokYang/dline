import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { lexSemanticInput } from "@shared/input-semantics/lexer"
import { describe, expect, it } from "vitest"
import { SemanticInputAdmissionService } from "../SemanticInputAdmissionService"

const catalog: InputSemanticCatalog = { revision: 4, descriptors: BUILTIN_INPUT_SEMANTICS }

function service(overrides?: { catalog?: InputSemanticCatalog }) {
	return new SemanticInputAdmissionService({
		catalog: () => overrides?.catalog ?? catalog,
		commands: {
			expand: async (invocation) => ({
				text: `<${invocation.canonicalName}-instructions>`,
				explicitInstructions: [{ type: "summarize_task", source: "manual_compact_command" }],
			}),
		},
		mentions: { resolve: async (node) => `<resolved:${node.canonicalRef}>` },
	})
}

function lex(rawText: string, activation?: "auto" | "candidate_only"): SemanticInputDocument {
	return lexSemanticInput(rawText, { catalog, documentId: "doc-1", activation })
}

async function admitText(document: SemanticInputDocument): Promise<string> {
	const result = await service().admit(document)
	if (!result.ok) throw new Error(`admission failed: ${result.diagnostics.map((d) => d.code).join(",")}`)
	return result.admitted.text
}

describe("SemanticInputAdmissionService", () => {
	it("expands the commands and mentions the document names, in node order", async () => {
		expect(await admitText(lex("/compact then read @/src/index.ts"))).toBe(
			"<compact-instructions> then read <resolved:/src/index.ts>",
		)
	})

	it("derives the authorized tool from catalog identity", async () => {
		const result = await service().admit(lex("/compact"))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.admitted.authorizedTools).toEqual(["summarize_task"])
		expect(result.admitted.plan.barrier?.commandId).toBe("command.compact")
		// The expansion's declaration travels with the submission so the provider
		// request can register one-shot authority for the compaction tool.
		expect(result.admitted.explicitInstructions).toEqual([{ type: "summarize_task", source: "manual_compact_command" }])
	})

	it("collects no authority when no command was planned", async () => {
		const result = await service().admit(lex("just text"))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.admitted.explicitInstructions).toEqual([])
	})

	it("binds text after the barrier as its premessage without expanding a later command", async () => {
		const result = await service().admit(lex("/compact summarize the audit /explain-changes"))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.admitted.plan.premessage.length).toBeGreaterThan(0)
		// The later command is content for the barrier, so it reaches the model as typed.
		expect(result.admitted.text).toContain("/explain-changes")
		expect(result.admitted.authorizedTools).toEqual(["summarize_task"])
	})

	it("rejects a document that declares two lifecycle barriers", async () => {
		const result = await service().admit(lex("/compact and /newtask"))

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics[0].code).toBe("semantic_input_lifecycle_barrier_invalid")
	})

	it("expands a composable command that runs before the barrier", async () => {
		const result = await service().admit(lex("/explain-changes then /compact"))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.admitted.plan.invocations.map((invocation) => invocation.commandId)).toEqual(["command.explain_changes"])
		expect(result.admitted.text).toBe("<explain-changes-instructions> then <compact-instructions>")
	})

	it("never promotes text that carries no entity, so a pasted /compact stays literal", async () => {
		const pasted = lex("log: /compact and @/etc/hosts", "candidate_only")

		const text = await admitText(pasted)

		expect(text).toBe("log: /compact and @/etc/hosts")
	})

	it("fails closed when the catalog moved on", async () => {
		const stale = { ...lex("/compact"), catalogRevision: "3" }

		const result = await service().admit(stale)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics[0].code).toBe("semantic_input_catalog_stale")
	})

	it("fails closed when a recognized command left the catalog, and names the node", async () => {
		const withdrawn: InputSemanticCatalog = {
			revision: 4,
			descriptors: BUILTIN_INPUT_SEMANTICS.filter((descriptor) => descriptor.id !== "command.compact"),
		}

		const result = await service({ catalog: withdrawn }).admit(lex("/compact"))

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics[0].code).toBe("semantic_input_command_unknown")
		expect(result.diagnostics[0].entityId).toBe("doc-1#0")
	})

	it("fails closed on a structurally broken document before touching any port", async () => {
		const broken: SemanticInputDocument = { ...lex("hi"), documentId: "" }

		const result = await service().admit(broken)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("semantic_input_schema_unsupported")
	})
})
