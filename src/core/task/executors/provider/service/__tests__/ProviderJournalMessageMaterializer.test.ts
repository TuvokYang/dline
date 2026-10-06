import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { serializeDurableToolResult } from "../../../../DurableToolResult"
import type { TaskPayloadStore } from "../../../../stores"
import { encodeTaskPayload } from "../../../../stores/payload/TaskPayloadCodec"
import { ProviderJournalMessageMaterializer } from "../ProviderJournalMessageMaterializer"

function payloadStore(payloads: Readonly<Record<string, Uint8Array>>): TaskPayloadStore {
	return {
		read: async (ref: string) => payloads[ref],
	} as unknown as TaskPayloadStore
}

describe("ProviderJournalMessageMaterializer", () => {
	it("collects the authority the admitted inputs of the turn granted", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "user_input",
					entryId: "entry-1",
					text: "/compact",
					explicitInstructions: [
						{
							type: "summarize_task",
							source: "manual_compact_command",
							targetTool: ClineDefaultTool.SUMMARIZE_TASK,
						},
					],
				}),
				"ref-2": encodeTaskPayload({ kind: "user_input", entryId: "entry-2", text: "and then continue" }),
			}),
		)

		const declarations = await materializer.collectAuthority(["ref-1", "ref-2"])

		expect(declarations).toEqual([
			{ type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
		])
	})

	it("ignores payloads that are not admitted user input", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({ kind: "environment_details", text: "environment" }),
				"ref-2": encodeTaskPayload({ kind: "dialog_selection", values: ["yes"] }),
			}),
		)

		expect(await materializer.collectAuthority(["ref-1", "ref-2"])).toEqual([])
	})

	// Submission context is separate from what the user typed: a TaskStart hook or
	// a spawn handoff records it alongside the text, and dropping it silently
	// removed the workspace policy the first turn was supposed to obey.
	it("appends the submission context to the admitted text", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "user_input",
					entryId: "entry-1",
					text: "do the thing",
					context: "WORKSPACE_POLICY",
				}),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message?.content).toEqual([
			{ type: "text", text: "<user_message>\ndo the thing\n\nWORKSPACE_POLICY\n</user_message>" },
		])
	})

	it("materializes context-only input when the submission carried no text", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({ kind: "user_input", entryId: "entry-1", context: "WORKSPACE_POLICY" }),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message?.content).toEqual([{ type: "text", text: "<user_message>\nWORKSPACE_POLICY\n</user_message>" }])
	})

	it("leaves the admitted text untouched when no context was recorded", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "user_input",
					entryId: "entry-1",
					text: "raw mirror",
					admittedText: "expanded text",
				}),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message?.content).toEqual([{ type: "text", text: "<user_message>\nexpanded text\n</user_message>" }])
	})

	// The submission that opens a task reaches the model as `<task>`, exactly as
	// the legacy runtime sent it; only later input is a `<user_message>`.
	it("sends the task's opening submission as the task", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "user_input",
					entryId: "entry-1",
					text: "raw mirror",
					admittedText: "E2E_OPENING_TASK",
					opensTask: true,
				}),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message?.content).toEqual([{ type: "text", text: "<task>\nE2E_OPENING_TASK\n</task>" }])
	})

	it("keeps the opening submission's context as its own block after the task", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "user_input",
					entryId: "entry-1",
					text: "do the thing",
					context: "WORKSPACE_POLICY",
					opensTask: true,
				}),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message?.content).toEqual([
			{ type: "text", text: "<task>\ndo the thing\n</task>" },
			{ type: "text", text: "<context>\nWORKSPACE_POLICY\n</context>" },
		])
	})

	const refused = {
		type: "tool_result" as const,
		function_id: "dline_function_01",
		dline_tid: "dline_tid_01",
		content: [
			{ type: "text" as const, text: "Explicit-only tool 'summarize_task' was rejected: explicit_instruction_missing." },
		],
	}

	it("replays a result paired with a recorded call as the canonical tool result", async () => {
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "tool_result",
					blockId: "dline_tid_01",
					content: serializeDurableToolResult(refused),
				}),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message).toMatchObject({ role: "user", content: [refused] })
	})

	// The call was kept in the history as the markup the model wrote, so there is
	// no provider call to pair with; the result speaks as prose instead.
	it("replays a result whose call was never recorded as prose without the call identity", async () => {
		const image = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" },
		}
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "tool_result",
					blockId: "dline_tid_01",
					content: serializeDurableToolResult(
						{ ...refused, content: [...refused.content, image] },
						{ kind: "text", toolName: "summarize_task" },
					),
				}),
			}),
		)

		const [message] = await materializer.materialize(["ref-1"])

		expect(message?.content).toEqual([
			{
				type: "text",
				text: "[summarize_task] Result:\nExplicit-only tool 'summarize_task' was rejected: explicit_instruction_missing.",
			},
			image,
		])
		expect(JSON.stringify(message)).not.toContain("dline_function_")
	})

	// A request to another model projects this turn as foreign history only if
	// the producer survives the journal; without it a switch loses the reasoning.
	it("restores the model that wrote a reply", async () => {
		const modelInfo = { modelId: "source-model", providerId: "anthropic", mode: "act" as const }
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({
				"ref-1": encodeTaskPayload({
					kind: "provider_final",
					content: [{ type: "text", text: "answer" }],
					modelInfo,
					turnPlan: { mode: "serial", blocks: [] },
				}),
				"ref-2": encodeTaskPayload({
					kind: "provider_final",
					text: "older answer",
					turnPlan: { mode: "serial", blocks: [] },
				}),
			}),
		)

		const [attributed, unattributed] = await materializer.materialize(["ref-1", "ref-2"])

		expect(attributed).toMatchObject({ role: "assistant", modelInfo })
		expect(unattributed).toMatchObject({ role: "assistant" })
		expect(unattributed).not.toHaveProperty("modelInfo")
	})

	it("rejects a durable result whose replay marker is malformed", async () => {
		const malformed = JSON.stringify({ ...JSON.parse(serializeDurableToolResult(refused)), replay: { kind: "native" } })
		const materializer = new ProviderJournalMessageMaterializer(
			payloadStore({ "ref-1": encodeTaskPayload({ kind: "tool_result", blockId: "dline_tid_01", content: malformed }) }),
		)

		await expect(materializer.materialize(["ref-1"])).rejects.toThrow("InvalidDurableToolResult:dline_tid_01")
	})
})
