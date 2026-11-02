import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { describe, expect, it } from "vitest"
import { buildEffectiveModelInfo } from "../effective-model-info"
import { resolveProfileCatalogKey, resolveProfileOverrides } from "../profile-model-info"
import { readProviderConfigField, withProviderConfigField } from "../provider-config"

/** A Profile config the flattened OpenCode provider stores. */
function flatConfig() {
    return {
        mode: OpenCodeMode.OPEN_CODE_MODE_GO,
        apiFormat: 2,
        capabilities: { contextWindow: 200_000, maxTokens: 8_000 },
    }
}

/**
 * A Profile written before the flattening, whose shared fields sat under `model`.
 * Field 2 still decodes into `OpenCodeLegacyBase`, so this is a real value.
 */
function legacyNestedConfig() {
    return {
        mode: OpenCodeMode.OPEN_CODE_MODE_GO,
        model: { apiFormat: 2, capabilities: { contextWindow: 200_000, maxTokens: 8_000 } },
    }
}

describe("readProviderConfigField", () => {
    it("reads the flat address every provider writes", () => {
        expect(readProviderConfigField(flatConfig(), "apiFormat")).toBe(2)
        expect(readProviderConfigField(flatConfig(), "capabilities")).toEqual({
            contextWindow: 200_000,
            maxTokens: 8_000,
        })
    })

    it("falls back to the deprecated nested carrier so an older Profile keeps its settings", () => {
        expect(readProviderConfigField(legacyNestedConfig(), "apiFormat")).toBe(2)
        expect(readProviderConfigField(legacyNestedConfig(), "capabilities")).toEqual({
            contextWindow: 200_000,
            maxTokens: 8_000,
        })
    })

    it("prefers the flat address when a config carries the field in both shapes", () => {
        // After one save the flat address is the authority; the nested copy is
        // whatever the older carrier held and must not win again.
        expect(readProviderConfigField({ apiFormat: 3, model: { apiFormat: 2 } }, "apiFormat")).toBe(3)
    })

    it("reports no value for a field the config does not carry", () => {
        expect(readProviderConfigField(flatConfig(), "pricing")).toBeUndefined()
        expect(readProviderConfigField(undefined, "apiFormat")).toBeUndefined()
        expect(readProviderConfigField("not-a-config", "apiFormat")).toBeUndefined()
    })
})

describe("withProviderConfigField", () => {
    it("always writes the flat address, whichever shape the config arrived in", () => {
        const next = withProviderConfigField(legacyNestedConfig(), "apiFormat", 3) as unknown as {
            mode: number
            apiFormat: number
            model: { capabilities: unknown }
        }

        // The edited field moves to the flat address. A field this edit did not
        // touch stays wherever it already was until the next save rewrites it.
        expect(next.apiFormat).toBe(3)
        expect(next.mode).toBe(OpenCodeMode.OPEN_CODE_MODE_GO)
        expect(next.model.capabilities).toEqual({ contextWindow: 200_000, maxTokens: 8_000 })
        expect(Object.hasOwn(next, "capabilities")).toBe(false)
    })

    it("writes a provider-own field at the top level", () => {
        const next = withProviderConfigField({ reasoning: { enableThinking: true } }, "apiFormat", 2)
        expect(next).toEqual({ reasoning: { enableThinking: true }, apiFormat: 2 })
    })

    it("round-trips an OpenCode config through protobuf at the flat address", () => {
        const config = OpenCodeProviderConfig.create({ mode: OpenCodeMode.OPEN_CODE_MODE_GO })
        const protocol = withProviderConfigField(config, "apiFormat", 4)
        const updated = withProviderConfigField(protocol, "reasoning", { enableThinking: true })
        const profile = ApiProfile.create({ id: "protocol-roundtrip", provider: "opencode", opencode: updated })
        for (const restored of [
            ApiProfile.fromJSON(ApiProfile.toJSON(profile)),
            ApiProfile.decode(ApiProfile.encode(profile).finish()),
        ]) {
            expect(restored.opencode?.mode).toBe(OpenCodeMode.OPEN_CODE_MODE_GO)
            expect(restored.opencode?.apiFormat).toBe(4)
            expect(restored.opencode?.reasoning?.enableThinking).toBe(true)
        }
        expect(Object.hasOwn(updated, "apiFormat")).toBe(true)
    })

    it("does not mutate the config it was given", () => {
        const config = flatConfig()
        withProviderConfigField(config, "apiFormat", 1)
        expect(config.apiFormat).toBe(2)
    })
})

describe("shared readers over a Profile config", () => {
    it("applies the capability override the config carries", () => {
        const overrides = resolveProfileOverrides({
            provider: "opencode",
            opencode: flatConfig(),
        } as never)

        expect(overrides.capabilities).toEqual({ contextWindow: 200_000, maxTokens: 8_000 })
    })

    it("projects the override into the effective model info", () => {
        const info = buildEffectiveModelInfo(
            "claude-sonnet-5-5",
            undefined,
            resolveProfileOverrides({
                provider: "opencode",
                opencode: flatConfig(),
            } as never),
        )

        expect(info.capabilities?.contextWindow).toBe(200_000)
    })

    it("selects the catalog the stored mode names", () => {
        expect(resolveProfileCatalogKey({ provider: "opencode", opencode: flatConfig() } as never)).toBe("opencode-go")
        expect(
            resolveProfileCatalogKey({
                provider: "opencode",
                opencode: { mode: OpenCodeMode.OPEN_CODE_MODE_CONSOLE },
            } as never),
        ).toBe("opencode")
    })
})
