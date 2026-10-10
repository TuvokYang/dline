import type { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    azureOpenAi: vi.fn(function AzureOpenAi(options: unknown) {
        return { kind: "azure", options }
    }),
    createOpenAIClient: vi.fn(() => ({ kind: "openai" })),
    providerFetch: vi.fn(),
    buildExternalBasicHeaders: vi.fn(() => ({ "x-dline-external": "external" })),
    defaultAzureCredential: vi.fn(function DefaultAzureCredential() {
        return { kind: "credential" }
    }),
    getBearerTokenProvider: vi.fn(() => vi.fn(async () => "token")),
}))

vi.mock("openai", () => ({
    default: vi.fn(),
    AzureOpenAI: mocks.azureOpenAi,
}))
vi.mock("@/shared/net", () => ({
    createOpenAIClient: mocks.createOpenAIClient,
    providerFetch: mocks.providerFetch,
}))
vi.mock("@/services/EnvUtils", () => ({ buildExternalBasicHeaders: mocks.buildExternalBasicHeaders }))
vi.mock("@azure/identity", () => ({
    DefaultAzureCredential: mocks.defaultAzureCredential,
    getBearerTokenProvider: mocks.getBearerTokenProvider,
}))

import { createOpenAIClientForProfile } from "../openai-client-factory"

function profile(overrides: Partial<ApiProfile> = {}): ApiProfile {
    return {
        id: "openai-profile",
        name: "OpenAI",
        provider: "openai",
        apiKey: "secret",
        baseUrl: "https://api.openai.test/v1",
        modelId: "gpt-5",
        enabled: true,
        usedFor: ["act"],
        ...overrides,
    } as ApiProfile
}

describe("createOpenAIClientForProfile", () => {
    beforeEach(() => vi.clearAllMocks())

    it("uses the shared OpenAI transport and profile headers for standard endpoints", () => {
        const created = createOpenAIClientForProfile(
            profile({ openai: OpenAiProviderConfig.create({ openAiHeaders: { "x-profile": "profile" } }) }),
        )

        expect(created).toEqual({ kind: "openai" })
        expect(mocks.createOpenAIClient).toHaveBeenCalledWith({
            baseURL: "https://api.openai.test/v1",
            apiKey: "secret",
            defaultHeaders: { "x-profile": "profile" },
        })
        expect(mocks.azureOpenAi).not.toHaveBeenCalled()
    })

    it("preserves Azure API key, API version, transport, and merged headers", () => {
        createOpenAIClientForProfile(
            profile({
                baseUrl: "https://example.openai.azure.com/openai/deployments/images",
                openai: OpenAiProviderConfig.create({ azureApiVersion: "2026-01-01", openAiHeaders: { "x-profile": "profile" } }),
            }),
        )

        expect(mocks.azureOpenAi).toHaveBeenCalledWith({
            baseURL: "https://example.openai.azure.com/openai/deployments/images",
            apiKey: "secret",
            apiVersion: "2026-01-01",
            maxRetries: 0,
            defaultHeaders: { "x-dline-external": "external", "x-profile": "profile" },
            fetch: mocks.providerFetch,
        })
    })

    it("uses the injected Azure Identity token provider without requiring an API key", () => {
        const azureADTokenProvider = vi.fn(async () => "token")
        createOpenAIClientForProfile(
            profile({
                apiKey: undefined,
                baseUrl: "https://example.openai.azure.us/openai/deployments/images",
                openai: OpenAiProviderConfig.create({ azureIdentity: true }),
            }),
            { azureADTokenProvider },
        )

        expect(mocks.azureOpenAi).toHaveBeenCalledWith(expect.objectContaining({ azureADTokenProvider }))
        const azureOptions = mocks.azureOpenAi.mock.calls.at(0)?.[0]
        expect(azureOptions).not.toHaveProperty("apiKey")
        expect(mocks.defaultAzureCredential).not.toHaveBeenCalled()
    })

    it("fails before client construction when neither credential mode is configured", () => {
        expect(() => createOpenAIClientForProfile(profile({ apiKey: undefined }))).toThrow(
            "OpenAI API key or Azure Identity Authentication is required",
        )
        expect(mocks.createOpenAIClient).not.toHaveBeenCalled()
        expect(mocks.azureOpenAi).not.toHaveBeenCalled()
    })
})
