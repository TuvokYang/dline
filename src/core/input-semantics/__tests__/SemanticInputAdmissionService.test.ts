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

	it("splits the projection around the barrier so its premessage can be routed apart from the turn", async () => {
		const result = await service().admit(lex("/explain-changes then /compact keep the audit"))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		// The fake expander attaches one identical declaration per expanded command,
		// so declarations are told apart by position: the first belongs to
		// /explain-changes, the second to the /compact barrier itself.
		expect(result.admitted.explicitInstructions).toHaveLength(2)
		expect(result.admitted.barrier).toEqual({
			commandId: "command.compact",
			before: "<explain-changes-instructions> then",
			// A carrier without command authority, such as a dialog reply, keeps the typed form.
			sourceBefore: "/explain-changes then",
			premessage: "keep the audit",
			// Claiming the barrier drops only its own authority, never an earlier command's.
			instructionsBefore: result.admitted.explicitInstructions.slice(0, 1),
			// /explain-changes authorizes no tool; summarize_task belongs to the barrier alone.
			toolsBefore: [],
		})
		expect(result.admitted.authorizedTools).toEqual(["summarize_task"])
	})

	it("reports no barrier when the user placed none", async () => {
		const result = await service().admit(lex("/explain-changes please"))

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.admitted.barrier).toBeUndefined()
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

	it("reviews against the catalog a submission was composed with, not one published since", async () => {
		// Discovery advanced between lexing and admission. The document is not
		// stale — it names exactly the catalog it was built from — so refusing it
		// would drop a submission the user just made.
		const advanced: InputSemanticCatalog = { revision: 5, descriptors: BUILTIN_INPUT_SEMANTICS }

		const result = await service({ catalog: advanced }).admit(lex("/compact"), catalog)

		expect(result.ok).toBe(true)
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

	it("refuses a structure whose nodes do not reproduce the text the user submitted", async () => {
		// The visible text asks for a review; the forged node would run /compact instead.
		const forged: SemanticInputDocument = { ...lex("/compact"), rawText: "review this" }

		const result = await service().admit(forged)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics[0].code).toBe("semantic_input_node_invalid")
	})

	it("refuses an active command typed as text that is not one of its triggers", async () => {
		const lexed = lex("/compact")
		const [node] = lexed.nodes
		if (node?.kind !== "slash_command") throw new Error("expected a command node")
		const forged: SemanticInputDocument = {
			...lexed,
			rawText: "/review",
			nodes: [{ ...node, sourceText: "/review" }],
		}

		const result = await service().admit(forged)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics[0]).toMatchObject({ code: "semantic_input_node_invalid", entityId: node.entityId })
	})

	it("refuses an active command that claims a different composition than its descriptor", async () => {
		const lexed = lex("/compact")
		const [node] = lexed.nodes
		if (node?.kind !== "slash_command") throw new Error("expected a command node")
		// Downgrading the barrier to composable would expand /compact into the turn itself.
		const forged: SemanticInputDocument = { ...lexed, nodes: [{ ...node, compositionMode: "composable" }] }

		const result = await service().admit(forged)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics[0].code).toBe("semantic_input_node_invalid")
	})

	it("fails closed on a structurally broken document before touching any port", async () => {
		const broken: SemanticInputDocument = { ...lex("hi"), documentId: "" }

		const result = await service().admit(broken)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("semantic_input_schema_unsupported")
	})
})
