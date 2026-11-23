import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { applyTaskReasoningOverride, resolveTaskThinkingConfig, validateTaskReasoningOverride } from "@shared/task-reasoning"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenAiHandler } from "../openai"

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

function createProfile() {
    return ApiProfile.create({
        provider: "openai",
        modelId: "private-compatible-model",
        openai: { reasoning: { enableThinking: true } },
    })
}

afterEach(() => vi.restoreAllMocks())

describe("OpenAI compatible effort choices", () => {
    it("offers all compatibility choices without mutating metadata or inventing a default", () => {
        const profile = createProfile()
        const before = ApiProfile.toJSON(profile)
        const info = resolveProfileModelInfo(profile)
        expect(info.capabilities?.thinking?.effortLevels).toEqual(efforts)
        expect(info.capabilities?.thinking?.defaultEffort).toBeUndefined()
        expect(ApiProfile.toJSON(profile)).toEqual(before)
    })

    it.each(["minimal", "xhigh", "max", "ultra"])("validates and round-trips the %s Task override", (effort) => {
        const profile = createProfile()
        const thinking = resolveTaskThinkingConfig(resolveProfileModelInfo(profile).capabilities)
        const override = { kind: "effort" as const, effort }
        expect(validateTaskReasoningOverride(override, thinking)).toEqual({ valid: true, override })
        const updated = applyTaskReasoningOverride(profile, override)
        const restored = ApiProfile.fromJSON(ApiProfile.toJSON(updated))
        expect(restored.openai?.reasoning?.effort).toBe(effort)
        expect(profile.openai?.reasoning?.effort).toBeUndefined()
    })

    it("preserves declared restrictions, empty lists and opt-outs", () => {
        for (const thinking of [
            { supported: true, mode: "effort", effortLevels: ["high"] },
            { supported: true, mode: "effort", effortLevels: [] },
            { supported: false, mode: "effort", effortLevels: [] },
        ]) {
            const profile = createProfile()
            profile.modelInfo = { id: profile.modelId, capabilities: { thinking } }
            const capabilities = resolveProfileModelInfo(profile).capabilities
            expect(capabilities?.thinking).toEqual(thinking)
            expect(
                validateTaskReasoningOverride({ kind: "effort", effort: "xhigh" }, resolveTaskThinkingConfig(capabilities)),
            ).toMatchObject({ valid: false, error: "unsupported_effort" })
        }
    })

    describe.each([ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES])("wire format %s", (apiFormat) => {
        it.each([
            undefined,
            "minimal",
            "xhigh",
            "max",
            "ultra",
        ])("encodes %s without inventing or dropping a preference", async (effort) => {
            const profile = createProfile()
            profile.openai = OpenAiProviderConfig.create({
                ...profile.openai,
                apiFormat,
                reasoning: { enableThinking: true, effort },
            })
            const restored = ApiProfile.fromJSON(ApiProfile.toJSON(profile))
            const handler = new OpenAiHandler({ profile: restored, mode: "act" })
            const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
            vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
                chat: { completions: { create } },
                responses: { create },
            })
            for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
                // Exercise request construction without contacting a provider.
            }
            expect(create).toHaveBeenCalledTimes(1)
            const body = create.mock.calls[0][0]
            expect(body.model).toBe(profile.modelId)
            if (apiFormat === ApiFormat.OPENAI_CHAT) {
                expect(body.reasoning_effort).toBe(effort)
                expect(body.reasoning).toBeUndefined()
            } else {
                // Responses retains its existing ultra-to-max compatibility mapping.
                expect(body.reasoning).toEqual({
                    ...(effort ? { effort: effort === "ultra" ? "max" : effort } : {}),
                    summary: "auto",
                })
                expect(body.reasoning_effort).toBeUndefined()
            }
        })
    })
})
