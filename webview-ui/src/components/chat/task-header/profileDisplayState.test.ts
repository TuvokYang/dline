import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { resolveProfileDisplayState } from "./profileDisplayState"

const profiles = [
    ApiProfile.create({ id: "profile-a", name: "Alpha", legacyNames: ["Old Alpha"], enabled: true }),
    ApiProfile.create({ id: "profile-b", name: "Beta", enabled: true }),
]

describe("resolveProfileDisplayState", () => {
    it("reports loading before the shared Catalog is available", () => {
        expect(resolveProfileDisplayState({ profiles: [], loaded: false })).toEqual({
            kind: "loading",
            text: "Loading profiles…",
        })
    })

    it("reports Catalog load failure separately from an empty Catalog", () => {
        const error = new Error("Catalog read failed")
        expect(resolveProfileDisplayState({ profiles: [], loaded: false, error })).toEqual({
            kind: "load_error",
            text: "Profiles unavailable",
            detail: "Catalog read failed",
        })
    })

    it("resolves a selected Profile by stable ID even when its stored name is stale", () => {
        expect(
            resolveProfileDisplayState({
                profiles,
                loaded: true,
                profileId: "profile-a",
                profileName: "Stale Alpha",
            }),
        ).toMatchObject({ kind: "selected", text: "Alpha", profile: profiles[0] })
    })

    it("does not fall back by name when a stable ID was deleted", () => {
        expect(
            resolveProfileDisplayState({
                profiles: [ApiProfile.create({ id: "replacement", name: "Alpha", enabled: true })],
                loaded: true,
                profileId: "deleted-id",
                profileName: "Alpha",
            }),
        ).toEqual({ kind: "select", reason: "deleted", text: "Select profile", detail: "Alpha" })
    })

    it("resolves a name-only legacy binding through a unique historical name", () => {
        expect(
            resolveProfileDisplayState({
                profiles,
                loaded: true,
                profileName: "Old Alpha",
            }),
        ).toMatchObject({ kind: "selected", text: "Alpha", profile: profiles[0] })
    })

    it("reports an unresolved name-only binding as requiring selection", () => {
        expect(
            resolveProfileDisplayState({
                profiles,
                loaded: true,
                profileName: "Missing Alpha",
            }),
        ).toEqual({ kind: "select", reason: "missing", text: "Select profile", detail: "Missing Alpha" })
    })

    it("prompts for selection when no Profile has ever been selected", () => {
        expect(resolveProfileDisplayState({ profiles, loaded: true })).toEqual({
            kind: "select",
            reason: "unselected",
            text: "Select profile",
        })
    })

    it("prompts for creation when the loaded Catalog is empty", () => {
        expect(resolveProfileDisplayState({ profiles: [], loaded: true, profileName: "Missing Alpha" })).toEqual({
            kind: "create",
            text: "Create profile",
        })
    })

    it("requires a new selection when the bound Profile is disabled", () => {
        expect(
            resolveProfileDisplayState({
                profiles: [ApiProfile.create({ id: "disabled", name: "Disabled", enabled: false })],
                loaded: true,
                profileId: "disabled",
            }),
        ).toEqual({ kind: "select", reason: "invalid", text: "Select profile", detail: "Disabled" })
    })
})
