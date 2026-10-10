import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { acceptCatalogRevision, INITIAL_INPUT_SEMANTIC_CATALOG } from "../catalog-revision"

function catalog(revision: number, descriptors: InputSemanticCatalog["descriptors"]): InputSemanticCatalog {
    return { revision, descriptors }
}

describe("input semantic catalog revision", () => {
    it("starts from the built-in descriptors before the backend answers", () => {
        expect(INITIAL_INPUT_SEMANTIC_CATALOG.revision).toBe(0)
        expect(INITIAL_INPUT_SEMANTIC_CATALOG.descriptors).toEqual(BUILTIN_INPUT_SEMANTICS)
    })

    it("adopts a newer revision", () => {
        const current = catalog(2, [])
        const incoming = catalog(3, BUILTIN_INPUT_SEMANTICS)

        expect(acceptCatalogRevision(current, incoming)).toBe(incoming)
    })

    it("keeps the cached catalog when an older revision arrives late", () => {
        const current = catalog(3, BUILTIN_INPUT_SEMANTICS)
        const stale = catalog(2, [])

        expect(acceptCatalogRevision(current, stale)).toBe(current)
    })

    it("accepts a resend of the same revision, because a new subscriber is replayed", () => {
        const current = catalog(3, [])
        const resent = catalog(3, BUILTIN_INPUT_SEMANTICS)

        expect(acceptCatalogRevision(current, resent)).toBe(resent)
    })
})
