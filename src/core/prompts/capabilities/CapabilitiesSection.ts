import { DlineDefaultTool } from "@shared/tools"
import { getPrompt } from "../i18n"
import { PromptProfile } from "../profiles/types"
import { assemblePromptFragments } from "../system-prompt/assembly/prompt-fragment-assembler"
import type { CapabilitiesSnapshot, CapabilityEntry, CapabilitySource } from "./types"

const GROUPS: Array<{ readonly titleKey: string; readonly key: keyof CapabilitiesSnapshot }> = [
    { titleKey: "mcpTitle", key: "mcp" },
    { titleKey: "skillsTitle", key: "skills" },
    { titleKey: "workflowsTitle", key: "workflows" },
    { titleKey: "subagentsTitle", key: "subagents" },
]

/**
 * Escape backticks in capability names before rendering inline code.
 *
 * @param name Capability name to render.
 * @returns Name with Markdown backticks escaped.
 */
function escapeName(name: string): string {
    return name.replace(/`/g, "\\`")
}

/**
 * Normalize capability descriptions into a single prompt-safe line.
 *
 * @param description Raw capability description.
 * @returns Sanitized description text.
 */
function normalizeDescription(description: string): string {
    return description.replace(/\s+/g, " ").trim().slice(0, 240)
}

/**
 * Render one capability entry using only name and description.
 *
 * @param entry Prompt-safe capability entry.
 * @returns Markdown list item for the capability.
 */
function renderEntry(entry: CapabilityEntry): string {
    const line = assemblePromptFragments(getPrompt("capabilityCatalog", "entry"), {
        NAME: escapeName(entry.name),
        DESCRIPTION: normalizeDescription(entry.description),
    })

    // Advertise the enforced tool allowlist when one exists, so the caller can
    // choose a capability by what it is actually permitted to do.
    if (!entry.tools || entry.tools.length === 0) return line
    return `${line}\n  - Tools: ${entry.tools.join(", ")}`
}

/** Select model-facing purpose and usage guidance for one capability group. */
function getGroupGuidance(group: keyof CapabilitiesSnapshot, profile: PromptProfile): string {
    switch (group) {
        case "mcp":
            return getPrompt("mcp", profile === PromptProfile.Lite ? "liteCatalogGuidance" : "standardCatalogGuidance")
        case "skills":
            return getPrompt("skills", "catalogGuidance")
        case "workflows":
            return getPrompt("workflows", profile === PromptProfile.Lite ? "liteCatalogGuidance" : "standardCatalogGuidance")
        case "subagents":
            return getPrompt("capabilityCatalog", "subagentsGuidance")
    }
}

/** Select the sentence that introduces the available entries for one capability group. */
function getGroupListIntroduction(group: keyof CapabilitiesSnapshot, profile: PromptProfile): string {
    switch (group) {
        case "mcp":
            return getPrompt(
                "mcp",
                profile === PromptProfile.Lite ? "liteCatalogListIntroduction" : "standardCatalogListIntroduction",
            )
        case "skills":
            return getPrompt("skills", "catalogListIntroduction")
        case "workflows":
            return getPrompt("workflows", "catalogListIntroduction")
        case "subagents":
            return getPrompt("capabilityCatalog", "subagentsListIntroduction")
    }
}

/** One rendered capability group, kept apart so its share of the prompt can be measured. */
export interface RenderedCapabilityGroup {
    readonly source: CapabilitySource
    readonly text: string
}

/**
 * Render the task-level Capabilities system prompt section.
 *
 * @param snapshot Prompt-safe capabilities snapshot.
 * @returns Markdown section containing only capability names and descriptions.
 */
export function renderCapabilitiesSection(
    snapshot: CapabilitiesSnapshot,
    options: { readonly exclude?: readonly CapabilitySource[]; readonly profile?: PromptProfile } = {},
): string {
    return joinCapabilityGroups(renderCapabilityGroups(snapshot, options))
}

/** Join rendered groups under the catalog heading, exactly as the Capabilities section reads. */
export function joinCapabilityGroups(groups: readonly RenderedCapabilityGroup[]): string {
    return [getPrompt("capabilityCatalog", "heading"), ...groups.map((group) => group.text)].join("\n\n")
}

/** Render each non-empty, non-excluded capability group in catalog order. */
export function renderCapabilityGroups(
    snapshot: CapabilitiesSnapshot,
    options: { readonly exclude?: readonly CapabilitySource[]; readonly profile?: PromptProfile } = {},
): RenderedCapabilityGroup[] {
    const groups: RenderedCapabilityGroup[] = []
    const excluded = new Set(options.exclude ?? [])
    for (const group of GROUPS) {
        if (excluded.has(group.key)) {
            continue
        }
        const entries = snapshot[group.key]
        if (entries.length === 0) {
            continue
        }
        const profile = options.profile ?? PromptProfile.Standard
        const guidance = getGroupGuidance(group.key, profile)
        const renderedGroup = assemblePromptFragments(getPrompt("capabilityCatalog", "group"), {
            TITLE: getPrompt("capabilityCatalog", group.titleKey),
            GUIDANCE: guidance,
            LIST_INTRODUCTION: getGroupListIntroduction(group.key, profile),
            ENTRIES: entries.map(renderEntry).join("\n"),
        })
        groups.push({ source: group.key, text: renderedGroup })
    }
    return groups
}

interface CapabilityPromptContext {
    readonly profile: PromptProfile
    readonly subagentsEnabled?: boolean
    readonly disableTools?: readonly DlineDefaultTool[]
}

/** Render only capability groups whose invocation tools are available in the current prompt context. */
export function renderCapabilitiesForContext(snapshot: CapabilitiesSnapshot, context: CapabilityPromptContext): string {
    return joinCapabilityGroups(renderCapabilityGroupsForContext(snapshot, context))
}

/** The groups {@link renderCapabilitiesForContext} joins, kept apart for measurement. */
export function renderCapabilityGroupsForContext(
    snapshot: CapabilitiesSnapshot,
    context: CapabilityPromptContext,
): RenderedCapabilityGroup[] {
    const exclude: CapabilitySource[] = []
    if (context.profile === PromptProfile.Lite) {
        exclude.push("skills", "subagents")
    } else {
        const disabled = new Set(context.disableTools ?? [])
        if (disabled.has(DlineDefaultTool.LOAD_SKILL)) exclude.push("skills")
        if (disabled.has(DlineDefaultTool.LOAD_WORKFLOW)) exclude.push("workflows")
        if (disabled.has(DlineDefaultTool.LOAD_MCP) || disabled.has(DlineDefaultTool.MCP_USE)) exclude.push("mcp")
        if (
            context.subagentsEnabled !== true ||
            disabled.has(DlineDefaultTool.USE_SUBAGENT) ||
            disabled.has(DlineDefaultTool.USE_SUBAGENTS)
        ) {
            exclude.push("subagents")
        }
    }
    return renderCapabilityGroups(snapshot, { exclude, profile: context.profile })
}
