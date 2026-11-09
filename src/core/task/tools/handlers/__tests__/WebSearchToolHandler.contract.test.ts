import type { ToolUse } from "@core/assistant-message"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "@core/prompts/__tests__/web-search-routing-fixtures"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { LocalSearchRegistry, type LocalSearchRequest } from "@/services/web-search/LocalSearchProvider"
import type { TaskConfig } from "../../types/TaskConfig"
import { WebSearchToolHandler } from "../WebSearchToolHandler"

vi.mock("@/services/telemetry", () => ({ telemetryService: { captureToolUsage: vi.fn() } }))

describe("WebSearchToolHandler prompt capability", () => {
    it.each([
        [false, "Extract matching links"],
        [true, "Extract matching links"],
        [false, undefined],
        [true, undefined],
    ] as const)("passes prompt only to supporting providers (%s, %j)", async (supportsPrompt, prompt) => {
        const requests: LocalSearchRequest[] = []
        const registry = new LocalSearchRegistry([
            {
                descriptor: { id: "bing", label: "Test search", execution: "dline", supportsPrompt },
                search: async (request) => {
                    requests.push(request)
                    return {
                        engineId: "bing",
                        query: request.query,
                        items: [
                            {
                                title: "Guide",
                                url: "https://example.test/guide",
                                snippet: request.prompt === "Extract matching links" ? "Matching links" : "Unprocessed excerpt",
                            },
                        ],
                    }
                },
            },
        ])
        const config = {
            taskState: { consecutiveMistakeCount: 0 },
            webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
            api: { getProviderId: () => "openai", getModel: () => ({ id: "local-search" }) },
            services: {
                stateManager: {
                    getGlobalSettingsKey: (key: string) => {
                        if (key === "localWebSearchEngine") return "bing"
                        if (key === "hooksEnabled") return false
                        return undefined
                    },
                    getSecretKey: () => undefined,
                },
            },
            callbacks: { say: async () => undefined },
        } as unknown as TaskConfig
        const block = {
            type: "tool_use",
            name: DlineDefaultTool.WEB_SEARCH,
            params: { query: "Dline", ...(prompt === undefined ? {} : { prompt }) },
            partial: false,
        } as ToolUse

        const result = await new WebSearchToolHandler(() => registry).execute(config, block)
        const directed = supportsPrompt && prompt !== undefined
        expect(requests).toEqual([directed ? { query: "Dline", prompt: "Extract matching links" } : { query: "Dline" }])
        expect(result).toContain(directed ? "Matching links" : "Unprocessed excerpt")
    })
})
