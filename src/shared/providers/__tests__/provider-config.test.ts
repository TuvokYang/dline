import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { describe, expect, it } from "vitest"
import { buildEffectiveModelInfo } from "../effective-model-info"
import { resolveProfileCatalogKey, resolveProfileOverrides } from "../profile-model-info"
import { readProviderConfigField, withProviderConfigField } from "../provider-config"

/**
 * A Profile config in the shape the OpenCode provider stores: the shared base
 * fields live under `model`, beside the fields only that provider has.
 */
function nestedConfig() {
    return {
        mode: OpenCodeMode.OPEN_CODE_MODE_GO,
        model: {
            apiFormat: 2,
            capabilities: { contextWindow: 200_000, maxTokens: 8_000 },
        },
    }
}

describe("readProviderConfigField", () => {
    it("reads a shared field a nested config keeps under its model message", () => {
        expect(readProviderConfigField(nestedConfig(), "apiFormat")).toBe(2)
        expect(readProviderConfigField(nestedConfig(), "capabilities")).toEqual({
            contextWindow: 200_000,
            maxTokens: 8_000,
        })
    })

    it("reads the top level of a flat config, which is where a provider without a nested message stores it", () => {
        expect(readProviderConfigField({ apiFormat: 4 }, "apiFormat")).toBe(4)
    })

    it("prefers the top level when a config carries the field in both shapes", () => {
        // The nested value is the older one under this rule; the flat value is what
        // a consumer that never wrote through this module would have stored.
        expect(readProviderConfigField({ apiFormat: 3, model: { apiFormat: 2 } }, "apiFormat")).toBe(3)
    })

    it("reports no value for a field the config does not carry", () => {
        expect(readProviderConfigField(nestedConfig(), "pricing")).toBeUndefined()
        expect(readProviderConfigField(undefined, "apiFormat")).toBeUndefined()
        expect(readProviderConfigField("not-a-config", "apiFormat")).toBeUndefined()
    })
})

describe("withProviderConfigField", () => {
    it("writes into the nested model message and leaves the provider's own fields alone", () => {
        const next = withProviderConfigField(nestedConfig(), "apiFormat", 3) as unknown as {
            mode: number
            model: { apiFormat: number; capabilities: unknown }
        }

        expect(next.model.apiFormat).toBe(3)
        expect(next.mode).toBe(OpenCodeMode.OPEN_CODE_MODE_GO)
        expect(next.model.capabilities).toEqual({ contextWindow: 200_000, maxTokens: 8_000 })
    })

    it("writes at the top level when the config has no nested message", () => {
        const next = withProviderConfigField({ reasoning: { enableThinking: true } }, "apiFormat", 2)
        expect(next).toEqual({ reasoning: { enableThinking: true }, apiFormat: 2 })
    })

    it("creates the generated nested model slot before saving a new OpenCode config", () => {
        const config = OpenCodeProviderConfig.create({ mode: OpenCodeMode.OPEN_CODE_MODE_GO })
        const protocol = withProviderConfigField(config, "apiFormat", 4)
        const updated = withProviderConfigField(protocol, "reasoning", { enableThinking: true })
        const profile = ApiProfile.create({ id: "protocol-roundtrip", provider: "opencode", opencode: updated })
        for (const restored of [
            ApiProfile.fromJSON(ApiProfile.toJSON(profile)),
            ApiProfile.decode(ApiProfile.encode(profile).finish()),
        ]) {
            expect(restored.opencode?.mode).toBe(OpenCodeMode.OPEN_CODE_MODE_GO)
            expect(restored.opencode?.model?.apiFormat).toBe(4)
            expect(restored.opencode?.model?.reasoning?.enableThinking).toBe(true)
        }
        expect(Object.hasOwn(updated, "apiFormat")).toBe(false)
        expect(config.model).toBeUndefined()
    })

    it("does not mutate the config it was given", () => {
        const config = nestedConfig()
        withProviderConfigField(config, "apiFormat", 1)
        expect(config.model.apiFormat).toBe(2)
    })
})

describe("shared readers over a nested config", () => {
    it("applies the capability override a nested config carries", () => {
        const overrides = resolveProfileOverrides({
            provider: "opencode",
            opencode: nestedConfig(),
        } as never)

        expect(overrides.capabilities).toEqual({ contextWindow: 200_000, maxTokens: 8_000 })
    })

    it("projects the override into the effective model info", () => {
        const info = buildEffectiveModelInfo(
            "claude-sonnet-5-5",
            undefined,
            resolveProfileOverrides({
                provider: "opencode",
                opencode: nestedConfig(),
            } as never),
        )

        expect(info.capabilities?.contextWindow).toBe(200_000)
    })

    it("selects the catalog the stored mode names", () => {
        expect(resolveProfileCatalogKey({ provider: "opencode", opencode: nestedConfig() } as never)).toBe("opencode-go")
        expect(
            resolveProfileCatalogKey({
                provider: "opencode",
                opencode: { mode: OpenCodeMode.OPEN_CODE_MODE_CONSOLE },
            } as never),
        ).toBe("opencode")
    })
})
