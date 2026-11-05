import type { ToolUse } from "@core/assistant-message"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "@core/prompts/__tests__/web-search-routing-fixtures"
import type { UiSayTool } from "@shared/ExtensionMessage"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import {
    BrowserWebFetchProvider,
    type LocalWebFetchProvider,
    type LocalWebFetchRequest,
    type UrlContentFetcherPort,
} from "@/services/web-fetch/LocalWebFetchProvider"
import type { TaskConfig } from "../../types/TaskConfig"
import { WebFetchToolHandler } from "../WebFetchToolHandler"

vi.mock("@/services/telemetry", () => ({ telemetryService: { captureToolUsage: vi.fn() } }))

describe("WebFetchToolHandler local input contract", () => {
    // Catches both rejecting a URL-only call and pretending a legacy prompt was used for analysis.
    it.each([undefined, "Legacy analysis input"])("fetches page content and ignores legacy prompt %j", async (prompt) => {
        const url = "https://example.test/raw-page"
        const pages = new Map([[url, "# Raw page\n\nIndependent page content"]])
        let browserOpen = false
        const fetcher: UrlContentFetcherPort = {
            launchBrowser: async () => {
                browserOpen = true
            },
            urlToMarkdown: async (requestedUrl, signal) => {
                if (!browserOpen || signal?.aborted) throw new Error("Browser is not available")
                const page = pages.get(requestedUrl)
                if (!page) throw new Error("Unexpected URL")
                return page
            },
            closeBrowser: async () => {
                browserOpen = false
            },
        }
        const rows: UiSayTool[] = []
        const config = {
            taskState: { operationSignal: new AbortController().signal, consecutiveMistakeCount: 0 },
            webToolsEnabled: true,
            webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
            api: { getProviderId: () => "openai", getModel: () => ({ id: "local-fetch" }) },
            services: { stateManager: { getGlobalSettingsKey: () => false } },
            callbacks: {
                say: async (type: string, text?: string) => {
                    if (type === "tool" && text) rows.push(JSON.parse(text) as UiSayTool)
                },
                sayAndCreateMissingParamError: async (_tool: string, parameter: string) =>
                    JSON.stringify({ error: "missing_parameter", parameter }),
            },
        } as unknown as TaskConfig
        const block = {
            type: "tool_use",
            name: DlineDefaultTool.WEB_FETCH,
            params: { url, ...(prompt === undefined ? {} : { prompt }) },
            partial: false,
        } as ToolUse
        const result = await new WebFetchToolHandler(new BrowserWebFetchProvider(() => fetcher)).execute(config, block)
        expect(typeof result).toBe("string")
        const response = JSON.parse(result as string)
        expect(response).toMatchObject({ url, content: "# Raw page\n\nIndependent page content" })
        expect(response).not.toHaveProperty("prompt")
        expect(browserOpen).toBe(false)
        expect(rows.map((row) => row.webFetch?.status)).toEqual(["running", "completed"])
        expect(rows.at(-1)?.webFetch).toStrictEqual({ schemaVersion: 1, status: "completed", ...response })
    })

    it.each([
        [false, "Extract page headings"],
        [true, "Extract page headings"],
        [false, undefined],
        [true, undefined],
    ] as const)("passes prompt only to supporting providers (%s, %j)", async (supportsPrompt, prompt) => {
        const url = "https://example.test/page"
        const signal = new AbortController().signal
        const requests: LocalWebFetchRequest[] = []
        const provider: LocalWebFetchProvider = {
            supportsPrompt,
            fetch: async (request) => {
                requests.push(request)
                return {
                    url: request.url,
                    content: request.prompt === "Extract page headings" ? "Page headings" : "Complete page content",
                    source: { id: "browser", label: "Browser Web Fetch", execution: "dline" },
                }
            },
        }
        const config = {
            taskState: { operationSignal: signal, consecutiveMistakeCount: 0 },
            webToolsEnabled: true,
            webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
            api: { getProviderId: () => "openai", getModel: () => ({ id: "local-fetch" }) },
            services: { stateManager: { getGlobalSettingsKey: () => false } },
            callbacks: { say: async () => undefined },
        } as unknown as TaskConfig
        const block = {
            type: "tool_use",
            name: DlineDefaultTool.WEB_FETCH,
            params: { url, ...(prompt === undefined ? {} : { prompt }) },
            partial: false,
        } as ToolUse

        const result = await new WebFetchToolHandler(provider).execute(config, block)
        const directed = supportsPrompt && prompt !== undefined
        expect(requests).toEqual([directed ? { url, signal, prompt: "Extract page headings" } : { url, signal }])
        expect(JSON.parse(result as string)).toMatchObject({
            url,
            content: directed ? "Page headings" : "Complete page content",
        })
    })
})
