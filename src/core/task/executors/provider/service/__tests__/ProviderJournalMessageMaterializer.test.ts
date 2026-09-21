import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
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
})
