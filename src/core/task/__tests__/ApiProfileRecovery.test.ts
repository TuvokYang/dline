import type { ApiProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
    createUnavailableApiHandler,
    resolveTaskApiProfile,
    validateApiProfileCredentials,
    validateResolvedTaskApiProfile,
} from "../ApiProfileRecovery"

const { profiles, freshProfiles } = vi.hoisted(() => ({
    profiles: [] as ApiProfile[],
    freshProfiles: [] as ApiProfile[],
}))

vi.mock("@core/controller/file/getApiProfiles", () => ({
    PROVIDER_API_KEY_MAP: {
        anthropic: "anthropicApiKey",
        openai: "openaiApiKey",
        openrouter: "openRouterApiKey",
    },
    findEnabledProfileByName: (name?: string) => profiles.find((profile) => profile.name === name && profile.enabled),
    readApiProfiles: () => profiles,
    readApiProfilesFresh: async () => freshProfiles,
}))

describe("resolveTaskApiProfile", () => {
    beforeEach(() => {
        profiles.length = 0
        freshProfiles.length = 0
    })

    it("keeps a legacy task profile whose enabled flag is omitted", () => {
        profiles.push({
            id: "legacy-task-id",
            name: "deepseek:deepseek-v4-pro:2",
            provider: "deepseek",
            modelId: "deepseek-v4-pro",
            apiKey: "test-key",
        } as ApiProfile)

        const result = resolveTaskApiProfile({ actModeProfile: "deepseek:deepseek-v4-pro:2" }, "act", "deepseek")

        expect(result.validity).toMatchObject({ status: "valid" })
        expect(result.resolvedProfile).toBe("deepseek:deepseek-v4-pro:2")
    })

    it("keeps an available task profile", () => {
        profiles.push({
            id: "task-id",
            name: "task-profile",
            provider: "anthropic",
            modelId: "claude-test",
            apiKey: "test-key",
            enabled: true,
        } as ApiProfile)

        const result = resolveTaskApiProfile({ actModeProfile: "task-profile" }, "act", "anthropic")

        expect(result).toMatchObject({ requestedProfile: "task-profile", resolvedProfile: "task-profile", usedFallback: false })
        expect(result.configuration.actModeProfile).toBe("task-profile")
    })

    it("adopts a renamed profile by stable id without treating it as fallback", () => {
        profiles.push({
            id: "profile-id",
            name: "renamed-profile",
            provider: "anthropic",
            modelId: "claude-test",
            apiKey: "test-key",
            enabled: true,
        } as ApiProfile)
        const persisted = {
            actModeProfile: "old-profile",
            actModeProfileId: "profile-id",
        }

        const result = resolveTaskApiProfile(persisted, "act", "anthropic")

        expect(result).toMatchObject({
            requestedProfile: "old-profile",
            resolvedProfile: "renamed-profile",
            usedFallback: false,
        })
        expect(result.configuration.actModeProfile).toBe("renamed-profile")
        expect(persisted.actModeProfile).toBe("old-profile")
    })

    it("migrates a name-only task through a unique historical Profile name", () => {
        profiles.push({
            id: "profile-id",
            name: "renamed-profile",
            legacyNames: ["old-profile"],
            provider: "anthropic",
            modelId: "claude-test",
            apiKey: "test-key",
            enabled: true,
        } as ApiProfile)

        const result = resolveTaskApiProfile({ actModeProfile: "old-profile" }, "act", "anthropic")

        expect(result).toMatchObject({
            requestedProfile: "old-profile",
            resolvedProfile: "renamed-profile",
            resolvedProfileId: "profile-id",
            usedFallback: false,
        })
        expect(result.configuration).toMatchObject({
            actModeProfileId: "profile-id",
            actModeProfile: "renamed-profile",
        })
    })

    it("rejects an ambiguous historical Profile name without selecting a fallback", () => {
        profiles.push(
            {
                id: "profile-a",
                name: "renamed-a",
                legacyNames: ["old-profile"],
                provider: "anthropic",
                modelId: "claude-a",
                apiKey: "test-key",
                enabled: true,
            } as ApiProfile,
            {
                id: "profile-b",
                name: "renamed-b",
                legacyNames: ["old-profile"],
                provider: "anthropic",
                modelId: "claude-b",
                apiKey: "test-key",
                enabled: true,
            } as ApiProfile,
        )

        const result = resolveTaskApiProfile({ actModeProfile: "old-profile" }, "act", "anthropic")

        expect(result).toMatchObject({
            resolvedProfile: undefined,
            usedFallback: false,
            validity: { status: "invalid", reason: "ambiguous" },
        })
        expect(result.error).toContain("matches multiple Profiles")
    })

    it("marks a missing task profile invalid instead of selecting an enabled fallback", () => {
        profiles.push(
            { id: "other-id", name: "other-provider", provider: "openrouter", enabled: true } as ApiProfile,
            { id: "replacement-id", name: "replacement", provider: "anthropic", enabled: true } as ApiProfile,
        )
        const persisted = { actModeProfile: "deleted-profile" }

        const result = resolveTaskApiProfile(persisted, "act", "anthropic")

        expect(result).toMatchObject({
            requestedProfile: "deleted-profile",
            resolvedProfile: undefined,
            usedFallback: false,
        })
        expect(result.configuration.actModeProfile).toBe("deleted-profile")
        expect(result.error).toContain("Profile not valid")
    })

    it("marks a disabled bound profile invalid even when another profile is enabled", () => {
        profiles.push(
            {
                id: "disabled-id",
                name: "disabled-profile",
                provider: "anthropic",
                modelId: "claude-test",
                apiKey: "test-key",
                enabled: false,
            } as ApiProfile,
            {
                id: "replacement-id",
                name: "replacement",
                provider: "anthropic",
                modelId: "claude-test",
                apiKey: "test-key",
                enabled: true,
            } as ApiProfile,
        )

        const result = resolveTaskApiProfile({ actModeProfile: "disabled-profile" }, "act", "anthropic")

        expect(result).toMatchObject({
            requestedProfile: "disabled-profile",
            resolvedProfile: undefined,
            usedFallback: false,
        })
        expect(result.configuration.actModeProfile).toBe("disabled-profile")
        expect(result.error).toContain("Profile not valid")
    })

    it("keeps history construction non-throwing when no enabled profile exists", async () => {
        const result = resolveTaskApiProfile({ planModeProfile: "deleted-profile" }, "plan", "anthropic")

        expect(result.error).toContain("Profile not valid")
        const handler = createUnavailableApiHandler(result.error as string)
        expect(handler.getModel().id).toBe("unavailable")
        await expect(handler.createMessage("", []).next()).rejects.toThrow(result.error)
    })

    it("validates Bedrock API key authentication from the nested provider config", async () => {
        const result = await validateApiProfileCredentials({
            id: "bedrock-id",
            name: "bedrock-profile",
            provider: "bedrock",
            modelId: "anthropic.claude-test",
            apiKey: "",
            enabled: true,
            bedrock: {
                awsAuthentication: "apikey",
                awsBedrockApiKey: "",
            } as ApiProfile["bedrock"],
        } as ApiProfile)

        expect(result).toMatchObject({ status: "invalid", reason: "credential_unavailable" })
    })

    it("does not require profile.apiKey for Bedrock profile or default-chain authentication", async () => {
        const result = await validateApiProfileCredentials({
            id: "bedrock-id",
            name: "bedrock-profile",
            provider: "bedrock",
            modelId: "anthropic.claude-test",
            apiKey: "",
            enabled: true,
            bedrock: {
                awsAuthentication: "profile",
                awsProfile: "",
            } as ApiProfile["bedrock"],
        } as ApiProfile)

        expect(result.status).toBe("valid")
    })

    it("allows Azure Identity OpenAI profiles without an API key", async () => {
        const result = await validateApiProfileCredentials({
            id: "azure-id",
            name: "azure-profile",
            provider: "openai",
            modelId: "gpt-test",
            apiKey: "",
            baseUrl: "https://resource.openai.azure.com",
            enabled: true,
            openai: { azureIdentity: true } as ApiProfile["openai"],
        } as ApiProfile)

        expect(result.status).toBe("valid")
    })

    it("requires an Azure endpoint even when an Azure API version is configured", async () => {
        const result = await validateApiProfileCredentials({
            id: "azure-id",
            name: "azure-profile",
            provider: "openai",
            modelId: "gpt-test",
            apiKey: "",
            baseUrl: "https://api.example.test",
            enabled: true,
            openai: {
                azureApiVersion: "2025-04-01-preview",
                azureIdentity: true,
            } as ApiProfile["openai"],
        } as ApiProfile)

        expect(result).toMatchObject({
            status: "invalid",
            reason: "configuration_invalid",
            message: 'Profile not valid: "azure-profile" requires an Azure endpoint for Azure Identity authentication.',
        })
    })

    it("requires SAP AI Core credentials from its provider config", async () => {
        const result = await validateApiProfileCredentials({
            id: "sap-id",
            name: "sap-profile",
            provider: "sapaicore",
            modelId: "sap-test",
            apiKey: "",
            baseUrl: "https://api.example.test",
            enabled: true,
            sapaicore: {
                clientId: "client-id",
                clientSecret: "",
                tokenUrl: "https://auth.example.test",
                resourceGroup: "default",
            } as ApiProfile["sapaicore"],
        } as ApiProfile)

        expect(result).toMatchObject({ status: "invalid", reason: "credential_unavailable" })
    })

    it("requires Vertex project and region instead of an API key", async () => {
        const result = await validateApiProfileCredentials({
            id: "vertex-id",
            name: "vertex-profile",
            provider: "vertex",
            modelId: "claude-test",
            apiKey: "",
            enabled: true,
            vertex: { vertexProjectId: "project-id", vertexRegion: "" } as ApiProfile["vertex"],
        } as ApiProfile)

        expect(result).toMatchObject({ status: "invalid", reason: "configuration_invalid" })
    })

    it("revalidates the selected stable id against the latest persisted Catalog", async () => {
        profiles.push({
            id: "profile-id",
            name: "profile",
            provider: "anthropic",
            modelId: "claude-test",
            apiKey: "cached-key",
            enabled: true,
        } as ApiProfile)
        freshProfiles.push({
            id: "profile-id",
            name: "profile",
            provider: "anthropic",
            modelId: "claude-test",
            apiKey: "",
            enabled: true,
        } as ApiProfile)

        const resolution = resolveTaskApiProfile({ actModeProfileId: "profile-id", actModeProfile: "profile" }, "act")
        const validity = await validateResolvedTaskApiProfile(resolution)

        expect(validity).toMatchObject({ status: "invalid", reason: "credential_unavailable" })
    })

    it.each([
        ["missing", "invalid", "credential_unavailable"],
        ["malformed", "invalid", "credential_malformed"],
        ["legacy-shared", "invalid", "credential_legacy_shared"],
        ["reauthentication-required", "invalid", "reauthentication_required"],
        ["refreshable-expired", "valid", undefined],
        ["authenticated", "valid", undefined],
    ] as const)("maps Codex OAuth status %s to Profile validity", async (authStatus, status, reason) => {
        const result = await validateApiProfileCredentials(
            {
                id: "codex-id",
                name: "codex-profile",
                provider: "openai-codex",
                modelId: "gpt-5-codex",
                apiKey: "",
                enabled: true,
            } as ApiProfile,
            { getOpenAiCodexAuthStatus: async (profile) => (profile.id === "codex-id" ? authStatus : "missing") },
        )

        expect(result).toMatchObject(reason ? { status, reason } : { status })
    })
})
