import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import {
    DISABLED_WEB_SEARCH_ROUTING_PLAN,
    HOSTED_WEB_SEARCH_ROUTING_PLAN,
    LOCAL_WEB_SEARCH_ROUTING_PLAN,
} from "../../__tests__/web-search-routing-fixtures"
import { SystemPromptGenerator } from "../../generators/SystemPromptGenerator"
import { ToolPromptGenerator } from "../../generators/ToolPromptGenerator"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../context"

const CONNECTED_MCP_HUB = {
    getServers: () => [
        {
            uid: "matrix",
            name: "Matrix Server",
            config: "{}",
            status: "connected" as const,
            tools: [],
        },
    ],
}

const BASE_CONTEXT = {
    cwd: "/workspace/project",
    ide: "Test IDE",
    providerInfo: {
        providerId: "cline",
        model: { id: "matrix-model", info: { id: "matrix-model", capabilities: {} } },
        mode: "act",
    },
    supportsBrowserUse: true,
    browserSettings: { viewport: { width: 1280, height: 800 }, disableToolUse: false },
    mcpHub: CONNECTED_MCP_HUB,
    focusChainSettings: { enabled: true, remindClineInterval: 6 },
    skills: [{ name: "review", description: "Review code changes.", path: "/skills/review.md", source: "project" }],
    subagentsEnabled: true,
    clineWebToolsEnabled: true,
    webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
    enableParallelToolCalling: true,
    yoloModeToggled: false,
    isCliEnvironment: false,
    isTesting: true,
} as unknown as SystemPromptContext

/** Extracts stable names from provider-native tool shapes. */
function toolNames(tools: ReturnType<ToolPromptGenerator["generate"]>): readonly string[] {
    return (tools ?? [])
        .map((tool) => {
            if ("function" in tool) return tool.function.name
            return "name" in tool ? tool.name : "[UNEXPECTED_TOOL_SHAPE]"
        })
        .filter((name): name is string => typeof name === "string")
}

/** Generates one explicit profile/transport matrix candidate. */
async function generate(profile: PromptProfile, transport: "native" | "xml", overrides: Partial<SystemPromptContext> = {}) {
    const context = {
        ...BASE_CONTEXT,
        ...overrides,
        promptProfile: profile,
        providerInfo: {
            ...BASE_CONTEXT.providerInfo,
            ...overrides.providerInfo,
        },
        enableNativeToolCalls: transport === "native",
    } as SystemPromptContext
    return new SystemPromptGenerator().generate(context)
}

/** Extracts the ACT MODE section so assertions cannot match the same wording elsewhere in the prompt. */
function actModeSection(result: Awaited<ReturnType<typeof generate>>): string {
    const start = result.systemPrompt.indexOf("## ACT MODE")
    const end = result.systemPrompt.indexOf("## PLAN MODE", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return result.systemPrompt.slice(start, end)
}

const SUBAGENT_DECISION_SOURCE = "Delegate independent research or review to subagents"
const WEB_DECISION_SOURCE = "Search the web for how similar problems have been solved"
const INTERACTIVE_USER_DECISIONS = "Interrupt the user only for"
const YOLO_USER_DECISIONS = "Asking is not available"

/** Reports whether one tool is exposed through the selected transport. */
function exposes(result: Awaited<ReturnType<typeof generate>>, transport: "native" | "xml", name: string): boolean {
    return transport === "native" ? toolNames(result.tools).includes(name) : result.systemPrompt.includes(`## ${name}`)
}

describe("Standard/Lite transport and capability behavior matrix", () => {
    it.each([
        [PromptProfile.Standard, "native"],
        [PromptProfile.Standard, "xml"],
        [PromptProfile.Lite, "native"],
        [PromptProfile.Lite, "xml"],
    ] as const)("preserves exact profile restrictions for %s/%s", async (profile, transport) => {
        const result = await generate(profile, transport)

        expect(result.profile).toBe(profile)
        expect(result.warnings).toEqual([])
        expect(exposes(result, transport, "read_file")).toBe(true)
        expect(exposes(result, transport, "browser_action")).toBe(profile === PromptProfile.Standard)
        expect(exposes(result, transport, "use_mcp_tool")).toBe(profile === PromptProfile.Standard)
        expect(exposes(result, transport, "web_search")).toBe(profile === PromptProfile.Standard)
        expect(exposes(result, transport, "generate_explanation")).toBe(false)
        expect(exposes(result, transport, "make_plan")).toBe(true)
        expect(exposes(result, transport, "qna_respond")).toBe(true)
        expect(exposes(result, transport, "generate_report")).toBe(true)
    })

    it.each(["act", "plan"] as const)("keeps make_plan available in %s mode", async (mode) => {
        const result = await generate(PromptProfile.Standard, "native", {
            providerInfo: { ...BASE_CONTEXT.providerInfo, mode },
        })

        expect(exposes(result, "native", "make_plan")).toBe(true)
    })

    it.each([
        [PromptProfile.Standard, "native"],
        [PromptProfile.Standard, "xml"],
        [PromptProfile.Lite, "native"],
        [PromptProfile.Lite, "xml"],
    ] as const)("offers working_respond and phase_report in both modes and never their former names for %s/%s", async (profile, transport) => {
        for (const mode of ["act", "plan"] as const) {
            const result = await generate(profile, transport, { providerInfo: { ...BASE_CONTEXT.providerInfo, mode } })

            expect(exposes(result, transport, DlineDefaultTool.WORKING_RESPOND), mode).toBe(true)
            expect(exposes(result, transport, DlineDefaultTool.PHASE_REPORT), mode).toBe(true)
            for (const formerName of [DlineDefaultTool.LEGACY_ACT_MODE_RESPOND, DlineDefaultTool.LEGACY_STATUS_UPDATE]) {
                expect(exposes(result, transport, formerName), mode).toBe(false)
                expect(result.systemPrompt, mode).not.toContain(formerName)
            }
        }
    })

    it.each(["native", "xml"] as const)("applies browser support and disable gates for Standard/%s", async (transport) => {
        const unsupported = await generate(PromptProfile.Standard, transport, { supportsBrowserUse: false })
        const disabled = await generate(PromptProfile.Standard, transport, {
            browserSettings: { viewport: { width: 1280, height: 800 }, disableToolUse: true },
        })

        expect(exposes(unsupported, transport, "browser_action")).toBe(false)
        expect(exposes(disabled, transport, "browser_action")).toBe(false)
    })

    it.each([
        "native",
        "xml",
    ] as const)("projects mutually exclusive local, hosted, and disabled web search for Standard/%s", async (transport) => {
        const local = await generate(PromptProfile.Standard, transport, {
            webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
        })
        const hosted = await generate(PromptProfile.Standard, transport, {
            webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN,
        })
        const disabled = await generate(PromptProfile.Standard, transport, {
            webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
        })

        expect(exposes(local, transport, "web_fetch")).toBe(true)
        expect(exposes(local, transport, "web_search")).toBe(true)

        expect(exposes(hosted, transport, "web_fetch")).toBe(true)
        expect(exposes(hosted, transport, "web_search")).toBe(false)

        // Web Tools is one switch over both web tools, so turning it off for a
        // profile withdraws Web Fetch alongside Web Search.
        expect(exposes(disabled, transport, "web_fetch")).toBe(false)
        expect(exposes(disabled, transport, "web_search")).toBe(false)
    })

    it.each(["native", "xml"] as const)("does not leak hosted web search into Lite/%s", async (transport) => {
        const hosted = await generate(PromptProfile.Lite, transport, {
            webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN,
        })

        expect(exposes(hosted, transport, "web_search")).toBe(false)
    })

    it.each(["native", "xml"] as const)("requires a connected enabled MCP server for Standard/%s", async (transport) => {
        const disconnected = await generate(PromptProfile.Standard, transport, {
            mcpHub: {
                getServers: () => [
                    {
                        uid: "offline",
                        name: "Offline Server",
                        config: "{}",
                        status: "disconnected" as const,
                        tools: [],
                    },
                ],
            } as unknown as SystemPromptContext["mcpHub"],
        })
        const disabled = await generate(PromptProfile.Standard, transport, {
            mcpHub: {
                getServers: () => [
                    {
                        uid: "disabled",
                        name: "Disabled Server",
                        config: "{}",
                        status: "connected" as const,
                        disabled: true,
                        tools: [],
                    },
                ],
            } as unknown as SystemPromptContext["mcpHub"],
        })

        expect(exposes(disconnected, transport, "use_mcp_tool")).toBe(false)
        expect(exposes(disabled, transport, "use_mcp_tool")).toBe(false)
    })

    it.each([
        "native",
        "xml",
    ] as const)("preserves focus, subagent, web, CLI, yolo, and parallel gates for Standard/%s", async (transport) => {
        const result = await generate(PromptProfile.Standard, transport, {
            focusChainSettings: { enabled: false, remindClineInterval: 0 },
            subagentsEnabled: false,
            clineWebToolsEnabled: false,
            webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
            isCliEnvironment: true,
            yoloModeToggled: true,
            enableParallelToolCalling: false,
        })

        expect(exposes(result, transport, "change_todo_list")).toBe(false)
        expect(exposes(result, transport, "use_subagents")).toBe(false)
        expect(exposes(result, transport, "web_search")).toBe(false)
        expect(exposes(result, transport, "generate_explanation")).toBe(false)
        expect(exposes(result, transport, "ask_followup_question")).toBe(false)
    })

    it.each([
        [PromptProfile.Standard, "native"],
        [PromptProfile.Standard, "xml"],
    ] as const)("gates the complete focus contract for %s/%s", async (profile, transport) => {
        const enabled = await generate(profile, transport)
        const disabled = await generate(profile, transport, {
            focusChainSettings: { enabled: false, remindClineInterval: 0 },
        })

        expect(exposes(enabled, transport, "change_todo_list")).toBe(true)
        expect(exposes(disabled, transport, "change_todo_list")).toBe(false)
        for (const toolName of ["ask_followup_question", "make_plan", "qna_respond", "generate_report"]) {
            expect(exposes(enabled, transport, toolName)).toBe(true)
        }
    })

    it.each([
        [PromptProfile.Lite, "native"],
        [PromptProfile.Lite, "xml"],
    ] as const)("keeps the complete focus contract disabled for %s/%s", async (profile, transport) => {
        const result = await generate(profile, transport, {
            focusChainSettings: { enabled: true, remindClineInterval: 6 },
        })

        expect(exposes(result, transport, "change_todo_list")).toBe(false)
        expect(JSON.stringify(result.tools ?? [])).not.toContain("task_progress")
    })

    it.each(["native", "xml"] as const)("renders ACT MODE decision sources from Standard/%s capabilities", async (transport) => {
        const local = actModeSection(await generate(PromptProfile.Standard, transport))
        const hosted = actModeSection(
            await generate(PromptProfile.Standard, transport, { webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN }),
        )
        const noWeb = actModeSection(
            await generate(PromptProfile.Standard, transport, {
                clineWebToolsEnabled: false,
                webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
            }),
        )
        const noSubagents = actModeSection(await generate(PromptProfile.Standard, transport, { subagentsEnabled: false }))
        const subagentRun = (await generate(PromptProfile.Standard, transport, { isSubagentRun: true })).systemPrompt

        expect(local).toContain(SUBAGENT_DECISION_SOURCE)
        expect(local).toContain(WEB_DECISION_SOURCE)
        expect(hosted).toContain(WEB_DECISION_SOURCE)
        expect(noWeb).not.toContain(WEB_DECISION_SOURCE)
        expect(noWeb).toContain(SUBAGENT_DECISION_SOURCE)
        expect(noSubagents).not.toContain(SUBAGENT_DECISION_SOURCE)
        expect(noSubagents).toContain(WEB_DECISION_SOURCE)
        // A subagent has no modes or turn-ending interaction tools, so its prompt carries no ACT MODE section.
        expect(subagentRun).not.toContain("## ACT MODE")
        expect(subagentRun).not.toContain(SUBAGENT_DECISION_SOURCE)
        for (const section of [local, hosted, noWeb, noSubagents, subagentRun]) {
            expect(section).not.toMatch(/@ACT_[A-Z_]+@/)
        }
    })

    it.each([
        [PromptProfile.Standard, "native"],
        [PromptProfile.Standard, "xml"],
        [PromptProfile.Lite, "native"],
        [PromptProfile.Lite, "xml"],
    ] as const)("switches ACT MODE user decisions with yolo mode for %s/%s", async (profile, transport) => {
        const interactive = actModeSection(await generate(profile, transport))
        const yolo = actModeSection(await generate(profile, transport, { yoloModeToggled: true }))

        expect(interactive).toContain(INTERACTIVE_USER_DECISIONS)
        expect(interactive).not.toContain(YOLO_USER_DECISIONS)
        expect(yolo).toContain(YOLO_USER_DECISIONS)
        expect(yolo).not.toContain(INTERACTIVE_USER_DECISIONS)
    })

    it.each(["native", "xml"] as const)("keeps subagent and web decision sources out of Lite/%s", async (transport) => {
        const section = actModeSection(
            await generate(PromptProfile.Lite, transport, { webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN }),
        )

        expect(section).not.toContain(SUBAGENT_DECISION_SOURCE)
        expect(section).not.toContain(WEB_DECISION_SOURCE)
        expect(section).not.toMatch(/@ACT_[A-Z_]+@/)
    })
})
