import { describe, expect, it } from "vitest"
import {
    normalizeModel,
    normalizeProvider,
    normalizeRole,
    resolveUsageIdentity,
    roleCarriesChecklist,
    UNKNOWN_USAGE_ID,
    USAGE_ROLE_CATALOG,
    usageFactKey,
    usageModelIdentityKey,
} from "../../contracts/usageIdentity"

describe("role normalization", () => {
    it("accepts only catalog values and never derives one from free text", () => {
        expect(normalizeRole("task")).toBe("task")
        expect(normalizeRole(" Subagent ")).toBe("subagent")
        // The wire allows `reviewer`, but this client has no path that runs one.
        expect(normalizeRole("reviewer")).toBeUndefined()
        // An arbitrary string is not a role, even when it matches the wire pattern.
        expect(normalizeRole("my_custom_role")).toBeUndefined()
        expect(normalizeRole("")).toBeUndefined()
    })

    it("covers the canonical catalog", () => {
        expect([...USAGE_ROLE_CATALOG]).toEqual(["task", "subagent", "compaction", "other"])
    })
})

describe("provider and model normalization", () => {
    it("lowercases and trims without changing identity", () => {
        expect(normalizeProvider("  Anthropic ")).toBe("anthropic")
        expect(normalizeModel("Claude-Opus-5-5")).toBe("claude-opus-5-5")
    })

    it("maps a model the wire pattern cannot carry onto a stable wire id", () => {
        // Bedrock and Ollama use characters the wire pattern does not carry. Mapping
        // them keeps the model nameable in a per-model analysis instead of losing it
        // to `_unknown`, and the mapping is deterministic for a given id.
        expect(normalizeModel("openai/gpt-4o")).toBe("openai_gpt-4o")
        expect(normalizeModel("openai:gpt-4o")).toBe("openai_gpt-4o")
        expect(normalizeModel("gpt 4o")).toBe("gpt_4o")
        expect(normalizeModel("qwen3:8b")).toBe("qwen3_8b")
    })

    it("maps deterministically, so the same id always lands in the same fact", () => {
        expect(normalizeModel("Acme/Model")).toBe(normalizeModel("acme/model"))
        // The mapping is many-to-one by nature: `acme/model` and `acme:model` share a
        // wire id. It only runs on values the provider itself reports, so the two are
        // the same model spelled by two providers' conventions, never two models of
        // one provider.
        expect(normalizeModel("acme/model")).toBe("acme_model")
        expect(normalizeModel("acme:model")).toBe("acme_model")
    })

    it("folds the forbidden placeholder ids into unknown rather than sending them", () => {
        expect(normalizeModel("_custom")).toBe(UNKNOWN_USAGE_ID)
        expect(normalizeModel("_other")).toBe(UNKNOWN_USAGE_ID)
    })

    it("refuses a provider outside the wire pattern or length", () => {
        expect(normalizeProvider("anthropic/eu")).toBeUndefined()
        expect(normalizeProvider("a".repeat(33))).toBeUndefined()
        expect(normalizeProvider("")).toBeUndefined()
    })

    it("truncates a model beyond the length bound instead of dropping it", () => {
        expect(normalizeModel("a".repeat(65))).toBe("a".repeat(64))
        expect(normalizeModel("a".repeat(64))).toBe("a".repeat(64))
    })
})

describe("fact identity resolution", () => {
    it("keeps custom and non-custom as separate identities", () => {
        const builtin = resolveUsageIdentity({ role: "task", provider: "anthropic", model: "opus", custom: false })
        const custom = resolveUsageIdentity({ role: "task", provider: "anthropic", model: "opus", custom: true })

        expect(builtin.ok && custom.ok).toBe(true)
        if (!builtin.ok || !custom.ok) return
        expect(usageFactKey(builtin.identity)).not.toBe(usageFactKey(custom.identity))
        expect(usageModelIdentityKey(builtin.identity)).not.toBe(usageModelIdentityKey(custom.identity))
    })

    it("keeps the same model under two providers apart", () => {
        const viaAnthropic = resolveUsageIdentity({ role: "task", provider: "anthropic", model: "opus", custom: false })
        const viaBedrock = resolveUsageIdentity({ role: "task", provider: "bedrock", model: "opus", custom: false })

        if (!viaAnthropic.ok || !viaBedrock.ok) throw new Error("expected valid identities")
        expect(usageFactKey(viaAnthropic.identity)).not.toBe(usageFactKey(viaBedrock.identity))
    })

    it("keeps the same model under two roles apart", () => {
        const asTask = resolveUsageIdentity({ role: "task", provider: "anthropic", model: "opus", custom: false })
        const asCompaction = resolveUsageIdentity({
            role: "compaction",
            provider: "anthropic",
            model: "opus",
            custom: false,
        })

        if (!asTask.ok || !asCompaction.ok) throw new Error("expected valid identities")
        expect(usageFactKey(asTask.identity)).not.toBe(usageFactKey(asCompaction.identity))
    })

    it("reports an unusable model as the explicit unknown bucket instead of dropping the fact", () => {
        const result = resolveUsageIdentity({ role: "task", provider: "anthropic", model: "   ", custom: false })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        // The provider is trustworthy, so the request is still counted under a bucket
        // a reader can query and delete. Silently dropping it would lose the tokens.
        expect(result.identity.model).toBe(UNKNOWN_USAGE_ID)
        expect(result.identity.provider).toBe("anthropic")
        // `custom` claims a free-form ID ran, which the unnamed model contradicts.
        expect(result.identity.custom).toBe(false)
    })

    it("rejects a forbidden placeholder rather than converting it to unknown", () => {
        // `_custom` and `_other` mean "folded away"; accepting them would let a
        // producer smuggle a merged identity into the canonical facts.
        expect(resolveUsageIdentity({ role: "task", provider: "anthropic", model: "_custom", custom: true })).toEqual({
            ok: false,
            reason: "model_forbidden",
        })
        expect(resolveUsageIdentity({ role: "task", provider: "anthropic", model: "_other", custom: false })).toEqual({
            ok: false,
            reason: "model_forbidden",
        })
    })

    it("rejects an unregistered role and folds an unusable provider into unknown", () => {
        expect(resolveUsageIdentity({ role: "made_up", provider: "anthropic", model: "opus", custom: false })).toEqual({
            ok: false,
            reason: "role_not_registered",
        })
        // A provider this build cannot state keeps the fact under `_unknown`, so the
        // tokens survive while the identity stays honestly unnamed.
        expect(resolveUsageIdentity({ role: "task", provider: "anthropic eu", model: "opus", custom: false })).toEqual({
            ok: true,
            identity: { role: "task", provider: UNKNOWN_USAGE_ID, model: "opus", custom: false },
        })
    })

    it("cannot produce the same key for two different tuples", () => {
        const keys = new Set([
            usageFactKey({ role: "task", provider: "a", model: "b", custom: false }),
            usageFactKey({ role: "task", provider: "a", model: "b", custom: true }),
            usageFactKey({ role: "task", provider: "a", model: "b_c", custom: false }),
            usageFactKey({ role: "task", provider: "a_b", model: "c", custom: false }),
        ])

        expect(keys.size).toBe(4)
    })
})

describe("checklist applicability", () => {
    it("allows a checklist only where the runtime has one", () => {
        expect(roleCarriesChecklist("task")).toBe(true)
        expect(roleCarriesChecklist("compaction")).toBe(true)
        // A subagent keeps no TODO list of its own.
        expect(roleCarriesChecklist("subagent")).toBe(false)
        expect(roleCarriesChecklist("other")).toBe(false)
        // The catalog registers no `reviewer`, so the role never becomes a fact; this
        // asserts the predicate stays conservative if one is ever passed in.
        expect(roleCarriesChecklist("reviewer" as never)).toBe(false)
    })
})
