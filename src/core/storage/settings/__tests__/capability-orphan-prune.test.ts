import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { pruneOrphanOverrides } from "../capability-orphan-prune"
import { capabilityResourceId } from "../capability-resource-id"

const AUTHORITATIVE = { scanComplete: true }

const ROOT = path.resolve("ws")
const CANONICAL_PATH = path.join(ROOT, ".agents", "skills", "review", "SKILL.md")
/**
 * A stored key that differs from the normalized id on every platform.
 *
 * An OS-native path alone would already equal its own normalized form on POSIX,
 * so the case below could not distinguish a literal-only matcher there.
 */
const RAW_PATH = `${CANONICAL_PATH}${path.sep}`
const NORMALIZED_ID = capabilityResourceId(CANONICAL_PATH)

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

    it("keeps an override stored under the raw scan path", () => {
        // Global and task maps are written from the path the panel received, so a
        // stored key can still be the raw scan path while discovery reports the
        // normalized id. Comparing them literally deleted the user's `false`.
        const result = pruneOrphanOverrides({
            overrides: { [RAW_PATH]: false },
            discoveredIds: new Set([NORMALIZED_ID]),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual([])
        expect(result.pruned).toBeUndefined()
    })

    it("keeps an override stored under the normalized id", () => {
        const result = pruneOrphanOverrides({
            overrides: { [NORMALIZED_ID]: false },
            discoveredIds: new Set([NORMALIZED_ID]),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual([])
        expect(result.pruned).toBeUndefined()
    })

    it("still removes a key that resolves to no discovered resource", () => {
        const stale = path.join(ROOT, ".agents", "skills", "deleted", "SKILL.md")
        const result = pruneOrphanOverrides({
            overrides: { [stale]: false },
            discoveredIds: new Set([NORMALIZED_ID]),
            ...AUTHORITATIVE,
        })

        expect(result.removedIds).toEqual([stale])
        expect(result.pruned).toEqual({})
    })

    it("keeps every override when the scan was incomplete", () => {
        const result = pruneOrphanOverrides({
            overrides: { "a/rule.md": false },
            discoveredIds: new Set(["b/other.md"]),
            scanComplete: false,
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
