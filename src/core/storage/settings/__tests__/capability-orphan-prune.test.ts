import { describe, expect, it } from "vitest"
import { pruneOrphanOverrides } from "../capability-orphan-prune"

const AUTHORITATIVE = { scanComplete: true, keysNormalized: true }

describe("pruneOrphanOverrides", () => {
    it("removes overrides whose resource is gone", () => {
        const result = pruneOrphanOverrides({
            overrides: { "a/rule.md": false, "b/gone.md": false },
            discoveredIds: new Set(["a/rule.md"]),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual(["b/gone.md"])
        expect(result.pruned).toEqual({ "a/rule.md": false })
    })

    it("writes nothing when every override still matches a resource", () => {
        const result = pruneOrphanOverrides({
            overrides: { "a/rule.md": false },
            discoveredIds: new Set(["a/rule.md", "b/other.md"]),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual([])
        expect(result.pruned).toBeUndefined()
    })

    it("keeps every override when the scan was incomplete", () => {
        const result = pruneOrphanOverrides({
            overrides: { "a/rule.md": false },
            discoveredIds: new Set(["b/other.md"]),
            scanComplete: false,
            keysNormalized: true,
        })

        expect(result.removedIds).toEqual([])
        expect(result.pruned).toBeUndefined()
    })

    it("keeps every override when the scan found nothing", () => {
        const result = pruneOrphanOverrides({
            overrides: { "a/rule.md": false },
            discoveredIds: new Set(),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual([])
        expect(result.pruned).toBeUndefined()
    })

    it("keeps every override until stored keys are normalized", () => {
        const result = pruneOrphanOverrides({
            overrides: { "A\\Rule.md": false },
            discoveredIds: new Set(["a/rule.md"]),
            scanComplete: true,
            keysNormalized: false,
        })

        expect(result.removedIds).toEqual([])
        expect(result.pruned).toBeUndefined()
    })

    it("never prunes remote overrides, which the local scan cannot see", () => {
        const result = pruneOrphanOverrides({
            overrides: { "remote:enterprise-skill": false, "b/gone.md": false },
            discoveredIds: new Set(["a/rule.md"]),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual(["b/gone.md"])
        expect(result.pruned).toEqual({ "remote:enterprise-skill": false })
    })
})
