import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { declaresWritePath, resolveToolPathParam } from "../tool-path-params"

describe("tool path parameters", () => {
	it.each(["src/file.ts", "../outside/file.ts", "@backend:src/file.ts"])("accepts the relative public path %s", (value) => {
		expect(resolveToolPathParam({ path: value })).toEqual({
			param: { name: "path", value, legacy: false },
		})
	})

	it.each([
		"/workspace/file.ts",
		String.raw`C:\workspace\file.ts`,
		String.raw`\\server\share\file.ts`,
	])("rejects the absolute public path %s", (value) => {
		expect(resolveToolPathParam({ path: value })).toMatchObject({
			error: expect.stringContaining("must be relative to a workspace"),
		})
	})

	it("accepts the legacy absolutePath alias for persisted calls", () => {
		const value = String.raw`C:\workspace\legacy.ts`

		expect(resolveToolPathParam({ absolutePath: value })).toEqual({
			param: { name: "absolutePath", value, legacy: true },
		})
	})

	it("uses a non-empty legacy alias when an empty path is also present", () => {
		expect(resolveToolPathParam({ path: "", absolutePath: "../legacy.ts" })).toEqual({
			param: { name: "absolutePath", value: "../legacy.ts", legacy: true },
		})
	})

	it("rejects ambiguous dual path declarations", () => {
		expect(resolveToolPathParam({ path: "src/new.ts", absolutePath: "/workspace/old.ts" })).toEqual({
			error: "Parameters 'path' and legacy 'absolutePath' cannot be used together.",
		})
	})

	it("identifies every single-target writer", () => {
		expect(declaresWritePath(ClineDefaultTool.FILE_NEW)).toBe(true)
		expect(declaresWritePath(ClineDefaultTool.FILE_EDIT)).toBe(true)
		expect(declaresWritePath(ClineDefaultTool.NEW_RULE)).toBe(true)
		expect(declaresWritePath(ClineDefaultTool.FILE_READ)).toBe(false)
	})
})
