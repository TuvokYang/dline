import { DlineDefaultTool } from "@shared/tools"
import { getPrompt } from "../i18n"
import { PromptProfile } from "../profiles/types"
import { assemblePromptFragments } from "../system-prompt/assembly/prompt-fragment-assembler"
import type { CapabilitiesSnapshot, CapabilityEntry, CapabilitySource, McpResourceCapabilityEntry } from "./types"

const GROUPS: Array<{ readonly titleKey: string; readonly key: CapabilitySource }> = [
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

/** Indent a rendered list item one level so it nests under the item above it. */
function nest(rendered: string): string {
    return rendered
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")
}

/**
 * Render a group's entries, listing MCP tools under the server that provides
 * them so one server's tools read as a unit. Each tool keeps its full advertised
 * name, which is what `load_mcp` resolves.
 */
function renderEntries(entries: readonly CapabilityEntry[]): string {
    const lines: string[] = []
    const byServer = new Map<string, CapabilityEntry[]>()
    for (const entry of entries) {
        if (entry.server === undefined) {
            lines.push(renderEntry(entry))
            continue
        }
        const tools = byServer.get(entry.server) ?? []
        tools.push(entry)
        byServer.set(entry.server, tools)
    }
    for (const [server, tools] of byServer) {
        lines.push(
            assemblePromptFragments(getPrompt("mcp", "serverEntry"), { NAME: escapeName(server), COUNT: String(tools.length) }),
            ...tools.map((tool) => nest(renderEntry(tool))),
        )
    }
    return lines.join("\n")
}

/** Render exact resource identities under their owning servers, without tool-loader metadata. */
function renderMcpResources(resources: readonly McpResourceCapabilityEntry[]): string {
    const byServer = new Map<string, McpResourceCapabilityEntry[]>()
    for (const resource of resources) {
        const entries = byServer.get(resource.server) ?? []
        entries.push(resource)
        byServer.set(resource.server, entries)
    }
    const lines: string[] = []
    for (const [server, entries] of byServer) {
        lines.push(
            assemblePromptFragments(getPrompt("mcp", "resourceServerEntry"), {
                NAME: escapeName(server),
                COUNT: String(entries.length),
            }),
            ...entries.map((entry) =>
                nest(
                    assemblePromptFragments(getPrompt("mcp", "resourceEntry"), {
                        URI: escapeName(entry.uri),
                        NAME: escapeName(entry.name),
                        DESCRIPTION: normalizeDescription(entry.description),
                    }),
                ),
            ),
        )
    }
    return assemblePromptFragments(getPrompt("mcp", "resourceCatalog"), { ENTRIES: lines.join("\n") })
}

/** Select model-facing purpose and usage guidance for one capability group. */
function getGroupGuidance(group: CapabilitySource, profile: PromptProfile): string {
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
function getGroupListIntroduction(group: CapabilitySource, profile: PromptProfile): string {
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
 * @returns Markdown catalog of capability identities, descriptions, and invocation guidance.
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
        const profile = options.profile ?? PromptProfile.Standard
        const resources = group.key === "mcp" && profile !== PromptProfile.Lite ? (snapshot.mcpResources ?? []) : []
        if (entries.length === 0 && resources.length === 0) {
            continue
        }
        const parts: string[] = []
        if (entries.length > 0) {
            parts.push(
                assemblePromptFragments(getPrompt("capabilityCatalog", "group"), {
                    TITLE: getPrompt("capabilityCatalog", group.titleKey),
                    GUIDANCE: getGroupGuidance(group.key, profile),
                    LIST_INTRODUCTION: getGroupListIntroduction(group.key, profile),
                    ENTRIES: renderEntries(entries),
                }),
            )
        } else {
            parts.push(`## ${getPrompt("capabilityCatalog", group.titleKey)}`)
        }
        if (resources.length > 0) parts.push(renderMcpResources(resources))
        groups.push({ source: group.key, text: parts.join("\n\n") })
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
    const disabled = new Set(context.disableTools ?? [])
    if (context.profile === PromptProfile.Lite) {
        exclude.push("skills", "subagents")
    } else {
        if (disabled.has(DlineDefaultTool.LOAD_SKILL)) exclude.push("skills")
        if (disabled.has(DlineDefaultTool.LOAD_WORKFLOW)) exclude.push("workflows")
        if (
            context.subagentsEnabled !== true ||
            disabled.has(DlineDefaultTool.USE_SUBAGENT) ||
            disabled.has(DlineDefaultTool.USE_SUBAGENTS)
        ) {
            exclude.push("subagents")
        }
    }
    // Lite keeps its existing MCP tool awareness catalog; only resources require an executable access tool.
    const mcpToolsDisabled =
        context.profile !== PromptProfile.Lite &&
        (disabled.has(DlineDefaultTool.LOAD_MCP) || disabled.has(DlineDefaultTool.MCP_USE))
    return renderCapabilityGroups(
        {
            ...snapshot,
            mcp: mcpToolsDisabled ? [] : snapshot.mcp,
            mcpResources: disabled.has(DlineDefaultTool.MCP_ACCESS) ? [] : snapshot.mcpResources,
        },
        { exclude, profile: context.profile },
    )
}
