import { buildApiHandlerFromProfile } from "@core/api"
import { normalizeApiProfile, serializeApiProfilesForStorage } from "@core/controller/file/getApiProfiles"
import { createRequestApiScope } from "@core/task/RequestApiScope"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { withSearchChoice } from "@shared/providers/model-web-search"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isNativeToolCallingConfig } from "@/utils/model-utils"
import { OpenAiHandler } from "../openai"

afterEach(() => vi.restoreAllMocks())

describe("model-scoped hosted Search requests", () => {
    it.each([
        { format: ApiFormat.OPENAI_RESPONSES, enabled: true, native: true, disabled: false, choose: true, hosted: true },
        { format: ApiFormat.OPENAI_CHAT, enabled: true, native: true, disabled: false, choose: true, hosted: false },
        { format: ApiFormat.OPENAI_RESPONSES, enabled: false, native: true, disabled: false, choose: true, hosted: false },
        { format: ApiFormat.OPENAI_RESPONSES, enabled: true, native: false, disabled: false, choose: true, hosted: false },
        { format: ApiFormat.OPENAI_RESPONSES, enabled: true, native: true, disabled: true, choose: true, hosted: false },
        { format: ApiFormat.OPENAI_RESPONSES, enabled: true, native: true, disabled: false, choose: false, hosted: false },
    ])("preserves protocol and switch boundaries: %j", async ({ format, enabled, native, disabled, choose, hosted }) => {
        const profile = normalizeApiProfile(
            ApiProfile.create({
                id: "manual-search",
                provider: "openai",
                modelId: "opaque-search-endpoint",
                modelInfo: choose ? withSearchChoice("opaque-search-endpoint", undefined) : undefined,
                openai: {
                    apiFormat: format,
                    capabilities: { supportsTools: true },
                },
            }),
        )
        profile.openai = OpenAiProviderConfig.create({
            ...profile.openai,
            disabledServerTools: disabled ? [ServerTool.WEB_SEARCH] : [],
        })
        const restored = normalizeApiProfile(serializeApiProfilesForStorage([profile])[0])
        const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
        vi.spyOn(OpenAiHandler.prototype as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create },
            chat: { completions: { create } },
        })
        const handler = buildApiHandlerFromProfile({}, "act", restored)
        const scope = createRequestApiScope(handler, "act", undefined, enabled, undefined, false, (info) =>
            isNativeToolCallingConfig(info, native),
        )
        expect(scope.webSearchRoutingPlan.serverTools).toEqual(hosted ? [ServerTool.WEB_SEARCH] : [])
        for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }], undefined, {
            serverTools: [...scope.webSearchRoutingPlan.serverTools],
        })) {
            // Consume the real request builder without network traffic.
        }
        expect(create).toHaveBeenCalledTimes(1)
        const body = create.mock.calls[0][0]
        expect((body.tools ?? []).filter((tool: { type: string }) => tool.type === "web_search")).toEqual(
            hosted ? [{ type: "web_search" }] : [],
        )
    })
})
