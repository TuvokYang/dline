import path from "node:path"
import { describe, expect, it } from "vitest"
import { StreamResponseHandler } from "../StreamResponseHandler"

describe("StreamResponseHandler malformed write path characterization", () => {
	it("recovers an unescaped sibling Windows relative path after JSON parsing fails", () => {
		const handler = new StreamResponseHandler(() => 300)
		const toolHandler = handler.getHandlers().toolUseHandler
		const identity = {
			function_id: "call_malformed_external_write",
			dline_tid: "dline_tid_malformed_external_write",
			provider_metadata: {},
		}
		const siblingPath = String.raw`..\u000workspace\xxx\proof.txt`
		const malformedArguments = `{"path":"${siblingPath}","content":"risk proof"}`

		expect(() => JSON.parse(malformedArguments)).toThrow()

		toolHandler.processToolUseDelta(
			{
				type: "tool_use",
				name: "write_to_file",
				input: malformedArguments,
			},
			identity,
		)

		const stored = toolHandler.getFinalizedToolUse(identity.dline_tid)
		const runtime = toolHandler.getPartialToolUsesAsContent()[0]

		expect(stored?.input).toMatchObject({
			path: siblingPath,
			content: "risk proof",
		})
		expect(runtime?.params).toMatchObject({
			path: siblingPath,
			content: "risk proof",
		})
		expect(path.win32.isAbsolute(runtime?.params.path ?? "")).toBe(false)
		expect(runtime?.params.path).toMatch(/^\.\.[\\/]/)
	})
})
