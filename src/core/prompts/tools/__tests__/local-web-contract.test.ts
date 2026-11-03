import { describe, expect, it } from "vitest"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { ToolPromptGenerator } from "../../generators/ToolPromptGenerator"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"

interface InputSchema {
    readonly properties: Record<string, unknown>
    readonly required: readonly string[]
}

function context(providerId: string, focus: boolean): SystemPromptContext {
    return {
        promptProfile: PromptProfile.Standard,
        providerInfo: { providerId, model: { id: "local-web-contract", info: {} } },
        enableNativeToolCalls: true,
        clineWebToolsEnabled: true,
        webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
        focusChainSettings: { enabled: focus, remindClineInterval: 6 },
    } as SystemPromptContext
}

function schemas(tools: ReturnType<ToolPromptGenerator["generate"]>): Map<string, InputSchema> {
    const result = new Map<string, InputSchema>()
    for (const tool of tools ?? []) {
        if ("function" in tool) result.set(tool.function.name, tool.function.parameters as unknown as InputSchema)
        else if ("input_schema" in tool) result.set(tool.name, tool.input_schema as unknown as InputSchema)
        else if ("name" in tool && typeof tool.name === "string" && "parameters" in tool)
            result.set(tool.name, tool.parameters as unknown as InputSchema)
    }
    return result
}

describe("local Web tool input contracts", () => {
    // Catches advertising an unused analysis argument or requiring it on any provider projection.
    it.each(["openai", "anthropic", "gemini"])("exposes only effective native inputs for %s", (providerId) => {
        for (const focus of [false, true]) {
            const projected = schemas(new ToolPromptGenerator().generate(PromptProfile.Standard, context(providerId, focus)))
            const fetch = projected.get("web_fetch")
            const search = projected.get("web_search")
            expect(fetch?.required).toEqual(["url"])
            expect(Object.keys(fetch?.properties ?? {})).toEqual(focus ? ["url", "task_progress"] : ["url"])
            expect(search?.required).toEqual(["query"])
            expect(Object.keys(search?.properties ?? {})).toEqual(
                focus
                    ? ["query", "allowed_domains", "blocked_domains", "task_progress"]
                    : ["query", "allowed_domains", "blocked_domains"],
            )
        }
    })

    it("gives the XML parser the same effective input names", () => {
        const xml = new ToolPromptGenerator().generateXml(PromptProfile.Standard, {
            ...context("openai", false),
            enableNativeToolCalls: false,
        })
        const usageParameters = (name: string) => {
            const usage = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? ""
            return [...usage.matchAll(/<([a-z_]+)><\/\1>/g)].map((match) => match[1])
        }
        expect(usageParameters("web_fetch")).toEqual(["url"])
        expect(usageParameters("web_search")).toEqual(["query", "allowed_domains", "blocked_domains"])
    })
})
