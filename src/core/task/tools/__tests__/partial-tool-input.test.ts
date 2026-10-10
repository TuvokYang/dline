import { describe, expect, it } from "vitest"
import { parsePartialToolInput } from "../partial-tool-input"

describe("parsePartialToolInput", () => {
	it("keeps ordinary fields closed while streaming a long response", () => {
		expect(parsePartialToolInput('{"path":"src/file.ts","response":"line 1\\nline')).toEqual({
			path: "src/file.ts",
			response: "line 1\nline",
		})
	})

	it("does not expose a half-written path", () => {
		expect(parsePartialToolInput('{"path":"src/half')).toEqual({})
	})

	it("returns complete JSON objects unchanged", () => {
		expect(parsePartialToolInput('{"result":"done","count":2}')).toEqual({ result: "done", count: 2 })
	})
})
