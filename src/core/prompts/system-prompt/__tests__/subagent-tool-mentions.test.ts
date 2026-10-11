import { DEFAULT_SUBAGENT_ALLOWED_TOOLS } from "@core/task/tools/subagent/DefaultSubagentConfig"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { SystemPromptGenerator } from "../../generators/SystemPromptGenerator"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../context"

const ALLOWED = new Set<string>(DEFAULT_SUBAGENT_ALLOWED_TOOLS)
const DISABLED = Object.values(DlineDefaultTool).filter((tool) => !ALLOWED.has(tool))

function subagentContext(profile: PromptProfile, native: boolean): SystemPromptContext {
    return {
        cwd: "/workspace/project",
        ide: "Test IDE",
        providerInfo: {
            providerId: "cline",
            model: { id: "matrix-model", info: { id: "matrix-model", capabilities: {} } },
            mode: "act",
        },
        promptProfile: profile,
        supportsBrowserUse: true,
        browserSettings: { viewport: { width: 1280, height: 800 }, disableToolUse: false },
        // SubagentRunner turns the focus chain off: a subagent keeps no TODO list.
        focusChainSettings: { enabled: false, remindClineInterval: 6 },
        skills: [],
        yoloModeToggled: false,
        enableNativeToolCalls: native,
        enableParallelToolCalling: false,
        isSubagentRun: true,
        disableTools: DISABLED,
        clineWebToolsEnabled: true,
        webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
        isTesting: true,
    } as unknown as SystemPromptContext
}

/** Disabled tool names the prompt text still mentions as whole words. */
function mentionedDisabledTools(prompt: string): string[] {
    return DISABLED.filter((tool) => new RegExp(`\\b${tool}\\b`).test(prompt))
}

describe("subagent system prompt", () => {
    it.each([
        [PromptProfile.Standard, true],
        [PromptProfile.Standard, false],
        [PromptProfile.Lite, true],
        [PromptProfile.Lite, false],
    ])("does not mention a tool the subagent cannot call (%s, native=%s)", async (profile, native) => {
        const generated = await new SystemPromptGenerator().generate(subagentContext(profile, native))

        expect(mentionedDisabledTools(generated.systemPrompt).join(" ")).toBe("")
    })
})
