import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import { MinimaxHandler } from "../minimax"
import { MistralHandler } from "../mistral"

/** Exercise effective declarations at the actual native request boundary, without substituting getModel. */
describe.each(["mistral", "minimax"] as const)("%s effective native tool choice", (provider) => {
	it.each([undefined, true, false])("uses the declared forced-tool flag %s without model-name inference", async (declared) => {
		const modelId = "claude-opus-5-5-alias"
		const profile = ApiProfile.create({
			provider,
			modelId,
			modelInfo: {
				id: modelId,
				name: "Effective alias",
				capabilities: { supportsTools: true, supportsForcedToolUse: declared, thinking: { supported: false } },
			},
		})
		const handler =
			provider === "mistral" ? new MistralHandler({ profile, mode: "act" }) : new MinimaxHandler({ profile, mode: "act" })
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client =
			provider === "mistral" ? { chat: { stream: create } } : { messages: { create } }
		const tools =
			provider === "mistral"
				? [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }]
				: [{ name: "read_file", description: "Read", input_schema: { type: "object", properties: {} } }]
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "read" }], tools as never)) {
		}
		const body = create.mock.calls[0]?.[0]
		expect(body.model).toBe(modelId)
		expect(handler.getModel().info.name).toBe("Effective alias")
		if (provider === "mistral") {
			expect(body.toolChoice).toBe(declared === false ? "auto" : "any")
		} else {
			expect(body.tool_choice).toEqual({ type: declared === false ? "auto" : "any" })
		}
	})
})
