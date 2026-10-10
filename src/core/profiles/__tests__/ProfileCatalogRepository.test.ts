import type { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { mergeProfileCatalog } from "../ProfileCatalogRepository"

const profile = (id: string, name: string, modelId: string): ApiProfile => ({ id, name, modelId, enabled: true }) as ApiProfile

describe("mergeProfileCatalog", () => {
    it("preserves a different Profile committed after the client baseline", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1")]
        const requested = [profile("a", "A", "a-2"), profile("b", "B", "b-1")]
        const latest = [profile("a", "A", "a-1"), profile("b", "B", "b-2")]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id, modelId }) => ({ id, modelId }))).toEqual([
            { id: "a", modelId: "a-2" },
            { id: "b", modelId: "b-2" },
        ])
    })

    it("uses the current commit for the same stable Profile ID", () => {
        const baseline = [profile("a", "A", "a-1")]
        const requested = [profile("a", "A", "a-3")]
        const latest = [profile("a", "A", "a-2")]

        expect(mergeProfileCatalog(baseline, requested, latest)[0]?.modelId).toBe("a-3")
    })

    it("deletes only IDs removed relative to the client baseline", () => {
        const baseline = [profile("a", "A", "a-1")]
        const requested: ApiProfile[] = []
        const latest = [profile("a", "A", "a-1"), profile("b", "B", "b-1")]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id }) => id)).toEqual(["b"])
    })

    it("applies a pure reorder of stable Profile IDs", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1"), profile("c", "C", "c-1")]
        const requested = [baseline[2], baseline[0], baseline[1]] as ApiProfile[]

        expect(mergeProfileCatalog(baseline, requested, baseline).map(({ id }) => id)).toEqual(["c", "a", "b"])
    })

    it("preserves the latest order when the client only changes fields", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1"), profile("c", "C", "c-1")]
        const requested = [profile("a", "A", "a-2"), baseline[1], baseline[2]] as ApiProfile[]
        const latest = [baseline[2], baseline[0], baseline[1]] as ApiProfile[]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id, modelId }) => ({ id, modelId }))).toEqual([
            { id: "c", modelId: "c-1" },
            { id: "a", modelId: "a-2" },
            { id: "b", modelId: "b-1" },
        ])
    })

    it("keeps concurrent additions in their latest slots while applying a reorder", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1"), profile("c", "C", "c-1")]
        const requested = [baseline[2], baseline[0], baseline[1]] as ApiProfile[]
        const latest = [baseline[0], profile("x", "X", "x-1"), baseline[1], profile("y", "Y", "y-1"), baseline[2]]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id }) => id)).toEqual(["c", "x", "a", "y", "b"])
    })

    it("preserves latest order when the client only appends a new Profile", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1")]
        const requested = [...baseline, profile("d", "D", "d-1")]
        const latest = [baseline[1], profile("x", "X", "x-1"), baseline[0]]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id }) => id)).toEqual(["b", "x", "a", "d"])
    })

    it("does not restore a concurrently deleted Profile while applying a reorder", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1"), profile("c", "C", "c-1")]
        const requested = [baseline[2], baseline[0], baseline[1]] as ApiProfile[]
        const latest = [baseline[0], baseline[2]]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id }) => id)).toEqual(["c", "a"])
    })

    it("combines reorder, deletion, client addition, and concurrent addition", () => {
        const baseline = [profile("a", "A", "a-1"), profile("b", "B", "b-1"), profile("c", "C", "c-1")]
        const requested = [profile("c", "C", "c-2"), profile("d", "D", "d-1"), baseline[0]] as ApiProfile[]
        const latest = [baseline[0], profile("x", "X", "x-1"), baseline[1], baseline[2]]

        expect(mergeProfileCatalog(baseline, requested, latest).map(({ id, modelId }) => ({ id, modelId }))).toEqual([
            { id: "c", modelId: "c-2" },
            { id: "x", modelId: "x-1" },
            { id: "d", modelId: "d-1" },
            { id: "a", modelId: "a-1" },
        ])
    })

    it("records the previous name when a stable Profile is renamed", () => {
        const baseline = [profile("a", "Alpha", "a-1")]
        const requested = [profile("a", "Renamed Alpha", "a-1")]

        expect(mergeProfileCatalog(baseline, requested, baseline)[0]).toMatchObject({
            name: "Renamed Alpha",
            legacyNames: ["Alpha"],
        })
    })

    it("preserves historical names when an older client omits the field", () => {
        const baseline = [profile("a", "Renamed Alpha", "a-1")]
        const requested = [profile("a", "Renamed Alpha", "a-2")]
        const latest = [{ ...profile("a", "Renamed Alpha", "a-1"), legacyNames: ["Alpha", "Older Alpha"] } as ApiProfile]

        expect(mergeProfileCatalog(baseline, requested, latest)[0]).toMatchObject({
            modelId: "a-2",
            legacyNames: ["Alpha", "Older Alpha"],
        })
    })

    it("deduplicates aliases and excludes the current or empty name", () => {
        const baseline = [{ ...profile("a", "Alpha", "a-1"), legacyNames: ["Older Alpha", ""] } as ApiProfile]
        const requested = [
            { ...profile("a", "Renamed Alpha", "a-1"), legacyNames: ["Older Alpha", "Renamed Alpha"] } as ApiProfile,
        ]

        expect(mergeProfileCatalog(baseline, requested, baseline)[0]?.legacyNames).toEqual(["Older Alpha", "Alpha"])
    })
})
