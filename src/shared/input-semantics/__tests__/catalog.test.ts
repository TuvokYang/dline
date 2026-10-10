import { describe, expect, it } from "vitest"
import {
    authorizedTools,
    BUILTIN_INPUT_SEMANTICS,
    establishesLifecycleBarrier,
    findDescriptor,
    type InputSemanticCatalog,
    validateComposition,
} from "../catalog"

function catalog(revision = 1): InputSemanticCatalog {
    return { revision, descriptors: BUILTIN_INPUT_SEMANTICS }
}

describe("input semantic catalog", () => {
    it("keeps every descriptor identity unique and free of user-facing text", () => {
        const ids = BUILTIN_INPUT_SEMANTICS.map((descriptor) => descriptor.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const descriptor of BUILTIN_INPUT_SEMANTICS) {
            expect(descriptor.id).toMatch(/^(command|mention)\.[a-z0-9_]+$/)
            expect(descriptor.id.startsWith(`${descriptor.kind}.`)).toBe(true)
        }
    })

    it("accepts several combinable mentions in one submission", () => {
        const violations = validateComposition(catalog(), ["mention.file", "mention.problems", "mention.terminal"])

        expect(violations).toEqual([])
        expect(establishesLifecycleBarrier(catalog(), ["mention.file"])).toBe(false)
    })

    it("refuses an exclusive command that shares a submission", () => {
        const violations = validateComposition(catalog(), ["command.compact", "mention.file"])

        expect(violations).toEqual([{ code: "exclusive_node_combined", nodeId: "command.compact" }])
    })

    it("reports an unknown node instead of silently dropping it", () => {
        expect(validateComposition(catalog(), ["command.does_not_exist"])).toEqual([
            { code: "unknown_node", nodeId: "command.does_not_exist" },
        ])
    })

    it("derives the manual compaction authorization and its lifecycle barrier from the node identity", () => {
        expect(authorizedTools(catalog(), ["command.compact"])).toEqual(["summarize_task"])
        expect(establishesLifecycleBarrier(catalog(), ["command.compact"])).toBe(true)
    })

    it("keeps the legacy triggers of a renamed command resolvable through aliases", () => {
        const compact = findDescriptor(catalog(), "command.compact")

        expect(compact?.trigger).toBe("/compact")
        expect(compact?.aliases).toContain("/smol")
        expect(compact?.aliases).toContain("/cmd:compact")
    })
})
