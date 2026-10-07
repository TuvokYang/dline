import { createCheckpointReferenceSet } from "@shared/checkpoints"
import { describe, expect, it } from "vitest"
import { decodeCheckpointWorkspaceRef, encodeCheckpointWorkspaceRef } from "../checkpoint-references"

describe("checkpoint workspace reference codec", () => {
	it("stores a single unrooted hash bare so pre-multi-root references keep one form", () => {
		const references = createCheckpointReferenceSet(["abc123"], [])

		const encoded = encodeCheckpointWorkspaceRef(references)

		expect(encoded).toBe("abc123")
		expect(decodeCheckpointWorkspaceRef(encoded)).toEqual(references)
	})

	it("round-trips a multi-root set with every hash bound to its root", () => {
		const references = createCheckpointReferenceSet(["hash-a", "hash-b"], ["/work/a", "/work/b"])

		const encoded = encodeCheckpointWorkspaceRef(references)

		expect(encoded.startsWith("{")).toBe(true)
		expect(decodeCheckpointWorkspaceRef(encoded)).toEqual(references)
	})

	it("keeps an empty slot for a root that produced no checkpoint", () => {
		const references = createCheckpointReferenceSet(["hash-a", ""], ["/work/a", "/work/b"])

		expect(decodeCheckpointWorkspaceRef(encodeCheckpointWorkspaceRef(references))).toEqual(references)
	})

	it("reads a legacy bare hash written before reference sets existed", () => {
		expect(decodeCheckpointWorkspaceRef("legacy-hash")).toEqual({ hashes: ["legacy-hash"], workspaceRoots: [] })
	})

	it.each([
		["an empty reference", ""],
		["malformed JSON", "{not json"],
		["a set without any hash", JSON.stringify({ hashes: [], workspaceRoots: ["/work/a"] })],
		["a set whose hashes are all empty", JSON.stringify({ hashes: ["", ""], workspaceRoots: ["/a", "/b"] })],
	])("rejects %s instead of restoring an unintended commit", (_label, workspaceRef) => {
		expect(decodeCheckpointWorkspaceRef(workspaceRef)).toBeUndefined()
	})
})
