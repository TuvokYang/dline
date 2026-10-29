import { describe, expect, it } from "vitest"
import { RuntimeContentPolicy, TELEMETRY_MASK_VALUE } from "../runtime/content-policy"
import { canonicalizeTelemetryProperties, flattenTelemetryProperties } from "./canonicalization"

describe("telemetry canonicalization", () => {
    it("flattens nested values without JSON-stringifying arrays", () => {
        expect(flattenTelemetryProperties({ nested: { ok: true }, list: ["one", "two"] })).toEqual({
            "nested.ok": true,
            "list.0": "one",
            "list.1": "two",
        })
    })

    it("masks content and identities while preserving safe operational metadata", () => {
        const result = canonicalizeTelemetryProperties(
            {
                user_name: "Alice",
                userId: "user-canary",
                organization_id: "org-canary",
                provider: "openai-codex",
                modelId: "gpt-5.3-codex",
                apiFormat: "openai-responses",
                model_list: ["gpt-5.3-codex", "gpt-5.2-codex"],
                apiError: "upstream response included secret body",
                nested: { prompt: "secret prompt", outcome: "success" },
            },
            new RuntimeContentPolicy(Buffer.alloc(32, 7)),
        )

        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain("Alice")
        expect(serialized).not.toContain("user-canary")
        expect(serialized).not.toContain("org-canary")
        expect(serialized).not.toContain("secret prompt")
        expect(serialized).not.toContain("upstream response included secret body")
        expect(result.attributes).toMatchObject({
            user_name: TELEMETRY_MASK_VALUE,
            userId: TELEMETRY_MASK_VALUE,
            organization_id: TELEMETRY_MASK_VALUE,
            provider: "openai-codex",
            modelId: "gpt-5.3-codex",
            apiFormat: "openai-responses",
            apiError: TELEMETRY_MASK_VALUE,
            "model_list.0": "gpt-5.3-codex",
            "model_list.1": "gpt-5.2-codex",
            "nested.prompt": TELEMETRY_MASK_VALUE,
            "nested.outcome": "success",
        })
        expect(result.contentPolicy.rejections).toHaveProperty("apiError", "masked_content")
        expect(result.contentPolicy.rejections).toHaveProperty("nested.prompt", "masked_content")
    })
})
