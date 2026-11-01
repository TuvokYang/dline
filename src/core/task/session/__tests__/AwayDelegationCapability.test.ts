import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "@core/prompts/__tests__/web-search-routing-fixtures"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import type { FrozenSystemPromptCache } from "@core/storage/task-context-types"
import { type ClineTool, DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { TaskProviderRequestFactory, type TaskProviderRequestFactoryOptions } from "../TaskProviderRequestFactory"

// The frame must advertise delegation only when the request actually offers it,
// not just because the current Settings value or an old prompt flag is true.
async function frame(input: {
    native?: boolean
    offersTool?: boolean
    frozenEnabled: boolean
    liveEnabled?: boolean
    profile?: PromptProfile
    nested?: boolean
    disabled?: boolean
}) {
    const api = { getProviderId: () => "openai", getModel: () => ({ id: "model", info: { id: "model" } }) }
    const context = {
        ide: "Test IDE",
        promptProfile: input.profile ?? PromptProfile.Standard,
        subagentsEnabled: input.liveEnabled ?? true,
        isSubagentRun: input.nested,
        disableTools: input.disabled ? [DlineDefaultTool.USE_SUBAGENT] : [],
        webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
        providerInfo: { providerId: "openai", model: api.getModel(), mode: "act" },
    } as SystemPromptContext
    const tools: readonly ClineTool[] | undefined = input.native
        ? input.offersTool
            ? [
                  {
                      type: "function",
                      function: {
                          name: DlineDefaultTool.USE_SUBAGENT,
                          description: "Delegate",
                          parameters: { type: "object", properties: {} },
                      },
                  },
              ]
            : [
                  {
                      type: "function",
                      function: {
                          name: DlineDefaultTool.FILE_READ,
                          description: "Read",
                          parameters: { type: "object", properties: {} },
                      },
                  },
              ]
        : undefined
    const frozen = {
        text: "frozen",
        promptBuilder: { profile: context.promptProfile, nativeTools: input.native, subagentsEnabled: input.frozenEnabled },
    } as FrozenSystemPromptCache
    const factory = new TaskProviderRequestFactory({
        taskId: "capability",
        api: { current: () => api },
        settings: { mode: "act" },
        stateManager: { getGlobalSettingsKey: () => false, getCanonicalSettingsKey: () => false },
        promptContext: { build: async () => context },
        prompt: { resolvePrompt: async () => frozen, getLastTools: () => tools, getPendingRefreshReason: () => undefined },
        usesNativeToolCalls: () => input.native === true,
    } as unknown as TaskProviderRequestFactoryOptions)
    return factory.frame(new AbortController().signal)
}

describe("Away delegation uses the frozen request capability", () => {
    it.each([
        { native: true, offersTool: false, frozenEnabled: true, expected: false },
        { native: true, offersTool: true, frozenEnabled: false, expected: true },
        { native: false, frozenEnabled: true, liveEnabled: false, expected: true },
        { native: false, frozenEnabled: false, liveEnabled: true, expected: false },
        { native: false, frozenEnabled: true, profile: PromptProfile.Lite, expected: false },
        { native: false, frozenEnabled: true, nested: true, expected: false },
        { native: false, frozenEnabled: true, disabled: true, expected: false },
    ])("projects $expected for %j", async ({ expected, ...input }) => {
        expect((await frame(input)).delegationAvailable).toBe(expected)
    })
})
