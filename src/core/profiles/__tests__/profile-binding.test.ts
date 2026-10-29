import type { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { resolveProfileReference } from "../profile-binding"

const PROFILES = [
    { id: "profile-a", name: "Alpha", enabled: true },
    { id: "profile-b", name: "Beta", enabled: true },
] as ApiProfile[]

describe("resolveProfileReference", () => {
    it("resolves stable ID before considering legacy names", () => {
        expect(resolveProfileReference(PROFILES, "profile-b")).toMatchObject({
            status: "resolved",
            profileId: "profile-b",
            profileName: "Beta",
            migratedFromLegacyName: false,
        })
    })

    it("migrates a unique legacy name to stable identity", () => {
        expect(resolveProfileReference(PROFILES, "Alpha")).toMatchObject({
            status: "resolved",
            profileId: "profile-a",
            profileName: "Alpha",
            migratedFromLegacyName: true,
        })
    })

    it("resolves a unique historical name after a Profile rename", () => {
        const profiles = [
            { id: "profile-a", name: "Renamed Alpha", legacyNames: ["Alpha"], enabled: true } as ApiProfile,
            PROFILES[1],
        ]

        expect(resolveProfileReference(profiles, "Alpha")).toMatchObject({
            status: "resolved",
            profileId: "profile-a",
            profileName: "Renamed Alpha",
            migratedFromLegacyName: true,
        })
    })

    it("rejects an ambiguous current name without selecting a fallback", () => {
        const profiles = [...PROFILES, { id: "profile-c", name: "Alpha", enabled: true } as ApiProfile]

        expect(resolveProfileReference(profiles, "Alpha")).toEqual({
            status: "invalid",
            reason: "ambiguous",
            error: 'Profile not valid: current name "Alpha" matches multiple Profiles.',
        })
    })

    it("rejects an ambiguous historical name without selecting a fallback", () => {
        const profiles = [
            { id: "profile-a", name: "Renamed Alpha", legacyNames: ["Alpha"], enabled: true } as ApiProfile,
            { id: "profile-b", name: "Other", legacyNames: ["Alpha"], enabled: true } as ApiProfile,
        ]

        expect(resolveProfileReference(profiles, "Alpha")).toEqual({
            status: "invalid",
            reason: "ambiguous",
            error: 'Profile not valid: historical name "Alpha" matches multiple Profiles.',
        })
    })

    it("prefers a unique current name over historical aliases", () => {
        const profiles = [
            { id: "profile-a", name: "Alpha", enabled: true } as ApiProfile,
            { id: "profile-b", name: "Beta", legacyNames: ["Alpha"], enabled: true } as ApiProfile,
        ]

        expect(resolveProfileReference(profiles, "Alpha")).toMatchObject({
            status: "resolved",
            profileId: "profile-a",
            profileName: "Alpha",
        })
    })

    it("rejects a missing reference without selecting a fallback", () => {
        expect(resolveProfileReference(PROFILES, "missing-profile")).toEqual({
            status: "invalid",
            reason: "missing",
            error: 'Profile not valid: "missing-profile" no longer exists.',
        })
    })
})
