import { describe, expect, it } from "vitest"
import { OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG, resolveOpenAiCodexRuntimeConfig } from "./runtime-config"

describe("resolveOpenAiCodexRuntimeConfig", () => {
    it("uses production endpoints and ignores overrides outside E2E", () => {
        expect(
            resolveOpenAiCodexRuntimeConfig({
                DLINE_E2E_OPENAI_CODEX_API_BASE_URL: "http://example.com/codex",
                DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL: "http://example.com/oauth",
            } as NodeJS.ProcessEnv),
        ).toEqual(OPENAI_CODEX_PRODUCTION_RUNTIME_CONFIG)
    })

    it("accepts loopback-only OAuth, API and usage overrides in E2E", () => {
        expect(
            resolveOpenAiCodexRuntimeConfig({
                E2E_TEST: "true",
                DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL: "http://127.0.0.1:43100/mock-oauth/",
                DLINE_E2E_OPENAI_CODEX_API_BASE_URL: "http://localhost:43200/mock-codex/",
                DLINE_E2E_OPENAI_CODEX_USAGE_URL: "http://[::1]:43300/mock-usage",
                DLINE_E2E_OPENAI_CODEX_OAUTH_MODE: "manual",
                DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS: "43101, 0",
                DLINE_E2E_OPENAI_CODEX_OAUTH_TIMEOUT_MS: "1250",
            } as NodeJS.ProcessEnv),
        ).toMatchObject({
            apiBaseUrl: "http://localhost:43200/mock-codex",
            usageUrl: "http://[::1]:43300/mock-usage",
            e2eOAuth: {
                authorizationEndpoint: "http://127.0.0.1:43100/mock-oauth/authorize/manual",
                tokenEndpoint: "http://127.0.0.1:43100/mock-oauth/token",
                mode: "manual",
                callbackPorts: [43101, 0],
                timeoutMs: 1250,
            },
        })
    })

    it.each([
        ["DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL", "https://auth.example.com"],
        ["DLINE_E2E_OPENAI_CODEX_API_BASE_URL", "http://192.0.2.10/codex"],
        ["DLINE_E2E_OPENAI_CODEX_USAGE_URL", "file:///tmp/usage"],
    ])("rejects non-loopback %s overrides", (name, value) => {
        expect(() =>
            resolveOpenAiCodexRuntimeConfig({
                E2E_TEST: "true",
                [name]: value,
            } as NodeJS.ProcessEnv),
        ).toThrow(/loopback HTTP URL/)
    })

    it.each([
        ["DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS", "1455,invalid"],
        ["DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS", "70000"],
        ["DLINE_E2E_OPENAI_CODEX_OAUTH_TIMEOUT_MS", "0"],
        ["DLINE_E2E_OPENAI_CODEX_OAUTH_TIMEOUT_MS", "1.5"],
    ])("rejects invalid %s values", (name, value) => {
        expect(() =>
            resolveOpenAiCodexRuntimeConfig({
                E2E_TEST: "true",
                DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL: "http://127.0.0.1:43100",
                [name]: value,
            } as NodeJS.ProcessEnv),
        ).toThrow(name)
    })

    it("rejects unknown E2E OAuth modes", () => {
        expect(() =>
            resolveOpenAiCodexRuntimeConfig({
                E2E_TEST: "true",
                DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL: "http://127.0.0.1:43100",
                DLINE_E2E_OPENAI_CODEX_OAUTH_MODE: "unsafe",
            } as NodeJS.ProcessEnv),
        ).toThrow("DLINE_E2E_OPENAI_CODEX_OAUTH_MODE")
    })
})
