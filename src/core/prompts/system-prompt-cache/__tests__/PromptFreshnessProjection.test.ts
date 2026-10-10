import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { describe, expect, it } from "vitest"
import { buildPromptFreshnessBaseline, comparePromptFreshness, settingsAffectPromptFreshness } from "../PromptFreshnessProjection"

const BASE_CONTEXT = {
    promptProfile: PromptProfile.Standard,
    providerInfo: {
        providerId: "openai",
        model: { id: "dline-test-model", info: { id: "dline-test-model" } },
        mode: "act",
    },
    ide: "vscode",
    supportsBrowserUse: true,
    browserSettings: {
        viewport: { width: 900, height: 600 },
        disableToolUse: false,
    },
    focusChainSettings: { enabled: false, remindClineInterval: 6 },
    subagentsEnabled: true,
    clineWebToolsEnabled: false,
    imageGenerationAvailable: true,
    enableNativeToolCalls: true,
    enableParallelToolCalling: false,
    terminalExecutionMode: "vscodeTerminal",
    defaultTerminalProfile: "default",
    terminalCommandTimeoutSeconds: 1_800,
} satisfies SystemPromptContext

const CAPABILITIES = {
    mcp: [{ name: "filesystem.read", description: "Read files" }],
    skills: [{ name: "review", description: "Review changes" }],
    workflows: [{ name: "release", description: "Prepare a release" }],
    subagents: [{ name: "reviewer", description: "Review code" }],
}

describe("PromptFreshnessProjection", () => {
    it("reports fresh when the current projection matches the frozen baseline", () => {
        const baseline = buildPromptFreshnessBaseline(BASE_CONTEXT, CAPABILITIES)

        expect(comparePromptFreshness(baseline, baseline, { checkedAt: 20, frozenAt: 10 })).toEqual({
            status: "fresh",
            changes: [],
            checkedAt: 20,
            frozenAt: 10,
        })
    })

    it.each([
        [true, false],
        [false, true],
    ] as const)("reports image tool availability changes from %s to %s", (frozenAvailable, currentAvailable) => {
        const frozen = buildPromptFreshnessBaseline({ ...BASE_CONTEXT, imageGenerationAvailable: frozenAvailable }, CAPABILITIES)
        const current = buildPromptFreshnessBaseline(
            { ...BASE_CONTEXT, imageGenerationAvailable: currentAvailable },
            CAPABILITIES,
        )

        expect(comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 })).toEqual({
            status: "stale",
            changes: [{ kind: "tool_set", summary: "Image generation tools changed" }],
            checkedAt: 20,
            frozenAt: 10,
        })
    })

    it("reports a prompt-safe Subagents summary when the visible catalog changes", () => {
        const frozen = buildPromptFreshnessBaseline(BASE_CONTEXT, CAPABILITIES)
        const current = buildPromptFreshnessBaseline(BASE_CONTEXT, {
            ...CAPABILITIES,
            subagents: [{ name: "secret-project-reviewer", description: "Updated private review policy" }],
        })

        const snapshot = comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 })

        expect(snapshot).toEqual({
            status: "stale",
            changes: [{ kind: "subagents", summary: "Subagents changed" }],
            checkedAt: 20,
            frozenAt: 10,
        })
        expect(JSON.stringify(snapshot)).not.toContain("secret-project-reviewer")
        expect(JSON.stringify(snapshot)).not.toContain("private review policy")
    })

    it.each([
        ["mcp", "MCP tools changed"],
        ["skills", "Skills changed"],
        ["workflows", "Workflows changed"],
    ] as const)("reports %s content-only changes without exposing the content", (group, summary) => {
        const marker = `PRIVATE_${group.toUpperCase()}_BODY`
        const frozen = buildPromptFreshnessBaseline(BASE_CONTEXT, {
            ...CAPABILITIES,
            [group]: [{ name: "shared", description: "Stable description", contentHash: "sha256:old" }],
        })
        const current = buildPromptFreshnessBaseline(BASE_CONTEXT, {
            ...CAPABILITIES,
            [group]: [{ name: "shared", description: "Stable description", contentHash: `sha256:new-${marker}` }],
        })

        const result = comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 })
        expect(result.changes).toEqual([{ kind: group, summary }])
        expect(JSON.stringify(result)).not.toContain(marker)
    })

    it("tracks MCP native tool identity only for native transport", () => {
        const nativeFrozen = buildPromptFreshnessBaseline(BASE_CONTEXT, {
            ...CAPABILITIES,
            mcp: [
                { name: "docs.search", description: "Search docs", contentHash: "sha256:schema", nativeToolHash: "sha256:old" },
            ],
        })
        const nativeCurrent = buildPromptFreshnessBaseline(BASE_CONTEXT, {
            ...CAPABILITIES,
            mcp: [
                { name: "docs.search", description: "Search docs", contentHash: "sha256:schema", nativeToolHash: "sha256:new" },
            ],
        })
        expect(comparePromptFreshness(nativeFrozen, nativeCurrent, { checkedAt: 20 }).changes).toEqual([
            { kind: "mcp", summary: "MCP tools changed" },
        ])

        const xmlContext = { ...BASE_CONTEXT, enableNativeToolCalls: false }
        const xmlFrozen = buildPromptFreshnessBaseline(xmlContext, {
            ...CAPABILITIES,
            mcp: [
                { name: "docs.search", description: "Search docs", contentHash: "sha256:schema", nativeToolHash: "sha256:old" },
            ],
        })
        const xmlCurrent = buildPromptFreshnessBaseline(xmlContext, {
            ...CAPABILITIES,
            mcp: [
                { name: "docs.search", description: "Search docs", contentHash: "sha256:schema", nativeToolHash: "sha256:new" },
            ],
        })
        expect(comparePromptFreshness(xmlFrozen, xmlCurrent, { checkedAt: 20 }).status).toBe("fresh")
    })

    it("ignores Skills and Subagents that are not visible in the Lite prompt", () => {
        const liteContext = { ...BASE_CONTEXT, promptProfile: PromptProfile.Lite }
        const frozen = buildPromptFreshnessBaseline(liteContext, CAPABILITIES)
        const current = buildPromptFreshnessBaseline(liteContext, {
            ...CAPABILITIES,
            skills: [{ name: "another-skill", description: "Changed" }],
            subagents: [{ name: "another-agent", description: "Changed" }],
        })

        expect(comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 }).status).toBe("fresh")
    })

    it.each([
        "globalClineRulesFileInstructions",
        "localClineRulesFileInstructions",
        "localCursorRulesFileInstructions",
        "localCursorRulesDirInstructions",
        "localWindsurfRulesFileInstructions",
        "localAgentsRulesFileInstructions",
    ] as const)("reports one privacy-safe Rules change when %s changes", (field) => {
        const frozen = buildPromptFreshnessBaseline({ ...BASE_CONTEXT, [field]: "secret rule version one" }, CAPABILITIES)
        const current = buildPromptFreshnessBaseline({ ...BASE_CONTEXT, [field]: "secret rule version two" }, CAPABILITIES)

        const result = comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 })

        expect(result.changes).toEqual([{ kind: "rules", summary: "Rules changed" }])
        expect(JSON.stringify(result)).not.toContain("secret rule")
    })

    it("deduplicates simultaneous Rules changes and persists only a content hash", () => {
        const marker = "PRIVATE_RULE_MARKER"
        const frozen = buildPromptFreshnessBaseline(BASE_CONTEXT, CAPABILITIES)
        const current = buildPromptFreshnessBaseline(
            {
                ...BASE_CONTEXT,
                globalClineRulesFileInstructions: `${marker}:global`,
                localClineRulesFileInstructions: `${marker}:local`,
                localAgentsRulesFileInstructions: `${marker}:agents`,
            },
            CAPABILITIES,
        )

        expect(comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 }).changes).toEqual([
            { kind: "rules", summary: "Rules changed" },
        ])
        expect(JSON.stringify(current)).not.toContain(marker)
        expect(current.rulesHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    })

    it("normalizes missing and empty prompt-visible rule instructions", () => {
        const frozen = buildPromptFreshnessBaseline(BASE_CONTEXT, CAPABILITIES)
        const current = buildPromptFreshnessBaseline({ ...BASE_CONTEXT, localClineRulesFileInstructions: "" }, CAPABILITIES)

        expect(comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 }).status).toBe("fresh")
    })

    it("returns unknown for a legacy frozen cache without a compatible baseline", () => {
        const current = buildPromptFreshnessBaseline(BASE_CONTEXT, CAPABILITIES)
        const legacy = { ...current, schemaVersion: 2 } as unknown as Parameters<typeof comparePromptFreshness>[0]

        for (const frozen of [undefined, legacy]) {
            expect(comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 })).toEqual({
                status: "unknown",
                changes: [],
                checkedAt: 20,
                frozenAt: 10,
            })
        }
    })

    it("classifies only committed Settings keys represented by the freshness projection", () => {
        expect(settingsAffectPromptFreshness(["subagentsEnabled"])).toBe(true)
        expect(settingsAffectPromptFreshness(["imageGenerationEnabled"])).toBe(true)
        expect(settingsAffectPromptFreshness(["browserSettings", "chatInputSendShortcut"])).toBe(true)
        expect(settingsAffectPromptFreshness(["lazyTeammateModeEnabled"])).toBe(true)
        expect(settingsAffectPromptFreshness(["chatInputSendShortcut", "terminalOutputLineLimit"])).toBe(false)
    })

    it("returns changes in a stable user-facing order", () => {
        const frozen = buildPromptFreshnessBaseline(BASE_CONTEXT, CAPABILITIES)
        const current = buildPromptFreshnessBaseline(
            {
                ...BASE_CONTEXT,
                browserSettings: { ...BASE_CONTEXT.browserSettings, viewport: { width: 1280, height: 800 } },
                localClineRulesFileInstructions: "changed",
            },
            { ...CAPABILITIES, mcp: [] },
        )

        expect(comparePromptFreshness(frozen, current, { checkedAt: 20, frozenAt: 10 }).changes).toEqual([
            { kind: "browser", summary: "Browser settings changed" },
            { kind: "rules", summary: "Rules changed" },
            { kind: "mcp", summary: "MCP tools changed" },
        ])
    })
})
