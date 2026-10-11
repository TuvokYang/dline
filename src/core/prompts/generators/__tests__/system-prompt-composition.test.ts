import { describe, expect, it } from "vitest"
import { LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { renderCapabilityGroupsForContext } from "../../capabilities/CapabilitiesSection"
import type { CapabilitiesSnapshot } from "../../capabilities/types"
import { PromptProfile } from "../../profiles/types"
import type { SystemPromptContext } from "../../system-prompt/context"
import { SystemPromptGenerator } from "../SystemPromptGenerator"
import {
    measureSystemPromptComposition,
    readSystemPromptComposition,
    type SystemPromptComposition,
} from "../system-prompt-composition"
import type { GeneratedSystemPrompt } from "../types"

function requireComposition(generated: GeneratedSystemPrompt): SystemPromptComposition {
    if (!generated.composition) throw new Error("the generator must measure the prompt it renders")
    return generated.composition
}

const CAPABILITIES: CapabilitiesSnapshot = {
    mcp: [{ name: "docs", description: "Documentation server." }],
    skills: [{ name: "review", description: "Review code changes against the project rules." }],
    workflows: [{ name: "release", description: "Ship a verified release candidate." }],
    subagents: [],
}

const RULES = ["Preferred language: zh-CN.", "Global project rules: keep functions small."]

const CONTEXT: SystemPromptContext = {
    promptProfile: PromptProfile.Standard,
    cwd: "/workspace/project",
    ide: "Test IDE",
    providerInfo: {
        providerId: "cline",
        model: {
            id: "test-model",
            info: { id: "test-model", capabilities: { supportsImages: false, supportsPromptCache: false } },
        },
        mode: "act",
    },
    preferredLanguageInstructions: RULES[0],
    globalClineRulesFileInstructions: RULES[1],
    capabilities: CAPABILITIES,
    webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
    enableNativeToolCalls: false,
    isTesting: true,
}

function groupText(source: "skills" | "workflows"): string {
    const groups = renderCapabilityGroupsForContext(CAPABILITIES, { profile: PromptProfile.Standard })
    return groups.find((group) => group.source === source)?.text ?? ""
}

describe("system prompt composition", () => {
    it("measures user rules, skills, workflows, and XML tool documentation inside the generated prompt", async () => {
        const generated = await new SystemPromptGenerator().generate(CONTEXT)
        const { systemPrompt } = generated
        const composition = requireComposition(generated)

        expect(composition.totalBytes).toBe(Buffer.byteLength(systemPrompt, "utf8"))
        expect(composition.userRulesBytes).toBe(Buffer.byteLength(RULES.join("\n\n"), "utf8"))
        expect(systemPrompt).toContain(RULES.join("\n\n"))
        for (const source of ["skills", "workflows"] as const) {
            const text = groupText(source)
            expect(text.length).toBeGreaterThan(0)
            expect(systemPrompt).toContain(text)
        }
        expect(composition.skillsBytes).toBe(Buffer.byteLength(groupText("skills"), "utf8"))
        expect(composition.workflowsBytes).toBe(Buffer.byteLength(groupText("workflows"), "utf8"))
        // XML transport documents every tool inside the prompt itself.
        expect(composition.toolDefinitionsBytes).toBeGreaterThan(0)
        const measured =
            composition.userRulesBytes + composition.skillsBytes + composition.workflowsBytes + composition.toolDefinitionsBytes
        expect(measured).toBeLessThan(composition.totalBytes)
    })

    it("leaves tool definitions out of a native prompt and rules out of a prompt without any", async () => {
        const generated = await new SystemPromptGenerator().generate({
            ...CONTEXT,
            enableNativeToolCalls: true,
            preferredLanguageInstructions: undefined,
            globalClineRulesFileInstructions: undefined,
        })

        const composition = requireComposition(generated)
        expect(composition.toolDefinitionsBytes).toBe(0)
        expect(composition.userRulesBytes).toBe(0)
        expect(composition.skillsBytes).toBeGreaterThan(0)
    })

    it("never lets measured parts exceed the prompt they were rendered into", () => {
        const composition = measureSystemPromptComposition({
            systemPrompt: "abcdef",
            userRules: "1234",
            skills: "5678",
            workflows: "x",
            toolDefinitions: "y",
        })

        expect(composition).toEqual({
            totalBytes: 6,
            userRulesBytes: 4,
            skillsBytes: 2,
            workflowsBytes: 0,
            toolDefinitionsBytes: 0,
        })
    })

    it.each([
        ["missing", undefined],
        ["partial", { totalBytes: 10, userRulesBytes: 1 }],
        ["negative", { totalBytes: 10, userRulesBytes: -1, skillsBytes: 0, workflowsBytes: 0, toolDefinitionsBytes: 0 }],
        ["fractional", { totalBytes: 10.5, userRulesBytes: 1, skillsBytes: 0, workflowsBytes: 0, toolDefinitionsBytes: 0 }],
        ["oversized parts", { totalBytes: 3, userRulesBytes: 2, skillsBytes: 2, workflowsBytes: 0, toolDefinitionsBytes: 0 }],
    ])("treats a %s persisted composition as unmeasured", (_name, value) => {
        expect(readSystemPromptComposition(value)).toBeUndefined()
    })

    it("reads back a consistent persisted composition", () => {
        const value = { totalBytes: 10, userRulesBytes: 1, skillsBytes: 2, workflowsBytes: 3, toolDefinitionsBytes: 4 }
        expect(readSystemPromptComposition(value)).toEqual(value)
    })
})
