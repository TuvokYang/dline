import { DlineDefaultTool as Tool } from "@shared/tools"
import { BookOpen, ChevronDown, ChevronRight, FlaskConical, LockKeyhole, Search, Server, Wrench } from "lucide-react"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { nativeSelectOptionStyle, nativeSelectStyle } from "@/components/ui/native-select-theme"

// Story-only example inventory. This module has no RPC or configuration writes.
type ResourceTab = "rules" | "skills" | "workflows" | "mcp"
type Tab = "tools" | ResourceTab
interface Resource {
    id: string
    name: string
    description: string
    scope: "Workspace" | "Global"
    requires: Tool[]
    content?: string
    server?: string
    resource?: boolean
    unavailable?: boolean
}

const SKILL_TOOLS = [Tool.LOAD_SKILL]
const WORKFLOW_TOOLS = [Tool.LOAD_WORKFLOW]
const MCP_TOOLS = [Tool.LOAD_MCP, Tool.MCP_USE]
const RESOURCES: Record<ResourceTab, Resource[]> = {
    rules: [
        {
            id: "rule-review",
            name: "review-guidelines.md",
            description: "Keep reviews focused on observable behavior and concrete evidence.",
            scope: "Workspace",
            requires: [],
            content: "Explain each finding with a concrete input, observable effect and relevant file path.",
        },
        {
            id: "rule-tests",
            name: "test-evidence.md",
            description: "Report the checks performed and any unverified behavior.",
            scope: "Global",
            requires: [],
            content: "Run focused checks for every changed behavior. State which checks were not run.",
        },
    ],
    skills: [
        {
            id: "skill-vitest",
            name: "use-vitest",
            description: "Run focused tests and diagnose failures.",
            scope: "Workspace",
            requires: SKILL_TOOLS,
        },
        {
            id: "skill-network",
            name: "using-shared-network",
            description: "Use shared transports, cancellation and cleanup.",
            scope: "Workspace",
            requires: SKILL_TOOLS,
        },
        {
            id: "skill-review",
            name: "review-checklist",
            description: "Check changes against the team's review checklist.",
            scope: "Global",
            requires: SKILL_TOOLS,
        },
    ],
    workflows: [
        {
            id: "workflow-e2e",
            name: "e2e-validation",
            description: "Select and run bounded end-to-end validation.",
            scope: "Workspace",
            requires: WORKFLOW_TOOLS,
        },
        {
            id: "workflow-pr",
            name: "pr-review",
            description: "Investigate a pull request without publishing a review.",
            scope: "Global",
            requires: WORKFLOW_TOOLS,
        },
    ],
    mcp: [
        {
            id: "github-search",
            name: "search_issues",
            description: "Search issues and pull requests.",
            scope: "Workspace",
            server: "github",
            requires: MCP_TOOLS,
        },
        {
            id: "github-pr",
            name: "get_pull_request",
            description: "Read a pull request and its changes.",
            scope: "Workspace",
            server: "github",
            requires: MCP_TOOLS,
        },
        {
            id: "github-resource",
            name: "repository://instructions",
            description: "Repository instructions resource.",
            scope: "Workspace",
            server: "github",
            resource: true,
            requires: [Tool.MCP_ACCESS],
        },
        {
            id: "docs-query",
            name: "query_docs",
            description: "Find documentation for a library.",
            scope: "Global",
            server: "docs",
            requires: MCP_TOOLS,
        },
        {
            id: "database-query",
            name: "query",
            description: "Server disconnected. Reconnect in MCP settings.",
            scope: "Global",
            server: "database",
            requires: MCP_TOOLS,
            unavailable: true,
        },
    ],
}
const TOOL_GROUPS = [
    { title: "Read & explore", tools: [Tool.FILE_READ, Tool.SEARCH, Tool.LIST_FILES] },
    { title: "Load instructions", tools: [Tool.LOAD_SKILL, Tool.LOAD_WORKFLOW] },
    { title: "MCP access", tools: [Tool.LOAD_MCP, Tool.MCP_USE, Tool.MCP_ACCESS] },
    { title: "Modify & execute", tools: [Tool.FILE_EDIT, Tool.FILE_NEW, Tool.BASH] },
]
export const PREVIEW_TOOLS = [Tool.FILE_READ, Tool.SEARCH, ...SKILL_TOOLS, ...WORKFLOW_TOOLS, ...MCP_TOOLS, Tool.MCP_ACCESS]
const INITIAL_SELECTION = ["rule-review", "skill-vitest", "workflow-e2e", "github-search"]
const TABS: Tab[] = ["tools", "rules", "skills", "workflows", "mcp"]
const LABELS: Record<Tab, string> = { tools: "Tools", rules: "Rules", skills: "Skills", workflows: "Workflows", mcp: "MCP" }
const PREREQUISITES: Record<ResourceTab, Tool[]> = {
    rules: [],
    skills: SKILL_TOOLS,
    workflows: WORKFLOW_TOOLS,
    mcp: [...MCP_TOOLS, Tool.MCP_ACCESS],
}

export interface SubagentCapabilitiesPreviewProps {
    initialTab?: Tab
    initialTools?: Tool[]
    emptyCatalog?: boolean
}

function SelectionRow({
    item,
    selected,
    missing,
    onToggle,
}: {
    item: Resource
    selected: boolean
    missing: Tool[]
    onToggle: () => void
}) {
    const disabled = missing.length > 0 || item.unavailable
    return (
        <label
            className={`flex gap-2.5 rounded px-2 py-2.5 ${disabled ? "opacity-55" : "cursor-pointer hover:bg-text-block-background"}`}>
            <input
                aria-label={`Use ${item.name}`}
                checked={selected}
                className="mt-0.5 shrink-0 accent-[var(--vscode-button-background)]"
                disabled={disabled}
                onChange={onToggle}
                type="checkbox"
            />
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-all text-xs font-medium">{item.name}</span>
                    {item.server && <span className="text-[10px] text-description">{item.resource ? "Resource" : "Tool"}</span>}
                    <span className="ml-auto text-[10px] text-description">{item.scope}</span>
                </span>
                <span className="mt-1 block text-xs text-description">{item.description}</span>
                {missing.length > 0 && (
                    <span className="mt-1 block text-[11px] text-warning">Requires {missing.join(" + ")}</span>
                )}
            </span>
        </label>
    )
}

/** Interactive design proposal, intentionally isolated from the production SubagentRow. */
export function SubagentCapabilitiesPreview({
    initialTab = "skills",
    initialTools = PREVIEW_TOOLS,
    emptyCatalog = false,
}: SubagentCapabilitiesPreviewProps) {
    const id = useId()
    const [tab, setTab] = useState<Tab>(initialTab)
    const [expanded, setExpanded] = useState(true)
    const [tools, setTools] = useState(new Set(initialTools))
    const [selection, setSelection] = useState(new Set(INITIAL_SELECTION))
    const [query, setQuery] = useState("")
    const [profile, setProfile] = useState("review-profile")
    const inventory = emptyCatalog ? { rules: [], skills: [], workflows: [], mcp: [] } : RESOURCES
    const missingTools = (item: Resource) => item.requires.filter((tool) => !tools.has(tool))
    const isActive = (item: Resource) => selection.has(item.id) && !item.unavailable && missingTools(item).length === 0
    const activeCount = (kind: ResourceTab) => inventory[kind].filter(isActive).length
    const chosenCount = (kind: ResourceTab) => inventory[kind].filter((item) => selection.has(item.id)).length
    const toggleTool = (tool: Tool) => {
        setTools((current) => {
            const next = new Set(current)
            if (next.has(tool)) next.delete(tool)
            else next.add(tool)
            return next
        })
    }
    const toggleResource = (item: Resource) => {
        if (missingTools(item).length || item.unavailable) return
        setSelection((current) => {
            const next = new Set(current)
            if (next.has(item.id)) next.delete(item.id)
            else next.add(item.id)
            return next
        })
    }
    const matches = (name: string, description = "") => `${name} ${description}`.toLowerCase().includes(query.toLowerCase())
    const visible =
        tab === "tools" ? [] : inventory[tab].filter((item) => matches(item.name, `${item.description} ${item.server ?? ""}`))
    const prerequisites = tab === "tools" ? [] : PREREQUISITES[tab]
    const missing = prerequisites.filter((tool) => !tools.has(tool))
    const systemPreview = [
        "You are reviewer, a code review subagent.",
        ...inventory.rules.filter(isActive).map((rule) => `# Rule: ${rule.name}\n${rule.content}`),
    ].join("\n\n")
    const changeTab = (next: Tab) => {
        setTab(next)
        setQuery("")
    }

    return (
        <main className="mx-auto max-w-[720px] p-4 text-foreground" data-testid="subagent-capabilities-preview">
            <div className="mb-4 flex items-start gap-2 rounded border border-editor-group-border bg-text-block-background p-3">
                <FlaskConical className="mt-0.5 shrink-0 text-link" size={16} />
                <div>
                    <div className="text-xs font-semibold">Subagent capabilities · Design preview</div>
                    <p className="mb-0 mt-1 text-xs text-description">
                        Example catalog. Changes stay in this story; no files are saved.
                    </p>
                </div>
            </div>
            <section aria-label="Subagent configuration" className="overflow-hidden rounded border border-editor-group-border">
                <button
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-2 border-0 bg-text-block-background p-3 text-left text-foreground cursor-pointer"
                    onClick={() => setExpanded(!expanded)}
                    type="button">
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="min-w-0 flex-1">
                        <span className="text-sm font-semibold">reviewer</span>
                        <span className="ml-2 text-[10px] text-description">Workspace subagent</span>
                        <span className="mt-0.5 block text-xs text-description">
                            Review changes with a focused set of tools and instructions.
                        </span>
                    </span>
                </button>
                {expanded && (
                    <div className="p-3">
                        <label className="mb-3 flex flex-col gap-1 text-xs" htmlFor={`${id}-profile`}>
                            <span className="font-medium">Profile</span>
                            <select
                                className="w-full rounded border p-1.5 text-xs"
                                id={`${id}-profile`}
                                onChange={(event) => setProfile(event.target.value)}
                                style={nativeSelectStyle}
                                value={profile}>
                                <option style={nativeSelectOptionStyle} value="">
                                    Default (act profile)
                                </option>
                                <option style={nativeSelectOptionStyle} value="review-profile">
                                    Review Profile
                                </option>
                                <option style={nativeSelectOptionStyle} value="fast-profile">
                                    Fast Profile
                                </option>
                            </select>
                        </label>
                        <div
                            aria-label="Capability categories"
                            className="flex border-b border-editor-group-border"
                            role="tablist">
                            {TABS.map((kind, index) => (
                                <button
                                    aria-controls={`${id}-panel-${kind}`}
                                    aria-selected={tab === kind}
                                    className={`flex min-w-0 flex-1 items-center justify-center gap-1 border-0 border-b-2 bg-transparent px-1 py-2 text-xs cursor-pointer ${tab === kind ? "border-link text-link" : "border-transparent text-description"}`}
                                    id={`${id}-tab-${kind}`}
                                    key={kind}
                                    onClick={() => changeTab(kind)}
                                    onKeyDown={(event) => {
                                        const next =
                                            event.key === "ArrowRight"
                                                ? (index + 1) % TABS.length
                                                : event.key === "ArrowLeft"
                                                  ? (index + TABS.length - 1) % TABS.length
                                                  : event.key === "Home"
                                                    ? 0
                                                    : event.key === "End"
                                                      ? TABS.length - 1
                                                      : undefined
                                        if (next === undefined) return
                                        event.preventDefault()
                                        changeTab(TABS[next])
                                        document.getElementById(`${id}-tab-${TABS[next]}`)?.focus()
                                    }}
                                    role="tab"
                                    tabIndex={tab === kind ? 0 : -1}
                                    type="button">
                                    {LABELS[kind]}
                                    <span className="rounded bg-text-block-background px-1 text-[10px]">
                                        {kind === "tools" ? tools.size + 1 : `${activeCount(kind)}/${chosenCount(kind)}`}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div aria-labelledby={`${id}-tab-${tab}`} id={`${id}-panel-${tab}`} role="tabpanel">
                            <div className="my-3 flex items-center gap-2 rounded border border-editor-group-border px-2">
                                <Search className="shrink-0 text-description" size={13} />
                                <input
                                    aria-label={`Search ${LABELS[tab]}`}
                                    className="min-w-0 flex-1 border-0 bg-transparent py-1.5 text-xs text-foreground outline-none"
                                    onChange={(event) => setQuery(event.target.value)}
                                    placeholder={`Search ${LABELS[tab].toLowerCase()}...`}
                                    type="search"
                                    value={query}
                                />
                            </div>
                            {tab !== "tools" && (
                                <>
                                    <p className="mb-2 text-xs text-description">
                                        {tab === "rules"
                                            ? "Selected rules are injected directly into this subagent's system prompt. No loader tool is required."
                                            : tab === "mcp"
                                              ? "Choose individual MCP tools and resources. Selection does not bypass approval."
                                              : `Choose which ${LABELS[tab].toLowerCase()} this subagent may load on demand, not up front.`}
                                    </p>
                                    {missing.length > 0 && (
                                        <div
                                            className="mb-2 rounded border border-editor-group-border bg-text-block-background p-2.5"
                                            role="note">
                                            <div className="flex items-center gap-1.5 text-xs font-medium">
                                                <LockKeyhole size={13} /> Missing prerequisite tools
                                            </div>
                                            <p className="my-1 text-[11px] text-description">
                                                Selections are kept but inactive until their required tools are enabled.
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {missing.map((tool) => (
                                                    <Button
                                                        key={tool}
                                                        onClick={() => toggleTool(tool)}
                                                        size="xs"
                                                        variant="secondary">
                                                        Enable {tool}
                                                    </Button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                            <div
                                className={`${tab === "rules" ? "h-[160px]" : "h-[280px]"} overflow-y-auto pr-1`}
                                data-testid="capability-catalog">
                                {tab === "tools" ? (
                                    <>
                                        {TOOL_GROUPS.map((group) => (
                                            <div className="mb-3" key={group.title}>
                                                <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-description">
                                                    <Wrench size={12} />
                                                    {group.title}
                                                </div>
                                                <div className="grid grid-cols-1 gap-1 min-[480px]:grid-cols-2">
                                                    {group.tools
                                                        .filter((tool) => matches(tool))
                                                        .map((tool) => (
                                                            <label
                                                                className="flex cursor-pointer items-center gap-2 rounded p-1.5 text-xs hover:bg-text-block-background"
                                                                key={tool}>
                                                                <input
                                                                    checked={tools.has(tool)}
                                                                    onChange={() => toggleTool(tool)}
                                                                    type="checkbox"
                                                                />
                                                                <span className="break-all">{tool}</span>
                                                            </label>
                                                        ))}
                                                </div>
                                            </div>
                                        ))}
                                        <label className="flex items-center gap-2 p-1.5 text-xs text-description">
                                            <input checked disabled type="checkbox" /> attempt_completion{" "}
                                            <span className="ml-auto text-[10px]">Always enabled</span>
                                        </label>
                                    </>
                                ) : visible.length === 0 ? (
                                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-description">
                                        <BookOpen size={22} />
                                        <span className="text-xs">
                                            {query ? "No matching capabilities." : `No ${LABELS[tab].toLowerCase()} available.`}
                                        </span>
                                        <span className="max-w-[300px] text-[11px]">
                                            {query
                                                ? "Try another search. Hidden selections are unchanged."
                                                : "Only enabled, discoverable capabilities would appear here."}
                                        </span>
                                    </div>
                                ) : (
                                    [...new Set(visible.map((item) => item.server ?? item.scope))].map((group) => (
                                        <div className="mb-2" key={group}>
                                            <div className="flex items-center gap-1.5 border-b border-editor-group-border px-2 py-1.5 text-[11px] font-semibold text-description">
                                                {tab === "mcp" && <Server size={12} />}
                                                {group}
                                            </div>
                                            {visible
                                                .filter((item) => (item.server ?? item.scope) === group)
                                                .map((item) => (
                                                    <SelectionRow
                                                        item={item}
                                                        key={item.id}
                                                        missing={missingTools(item)}
                                                        onToggle={() => toggleResource(item)}
                                                        selected={selection.has(item.id)}
                                                    />
                                                ))}
                                        </div>
                                    ))
                                )}
                            </div>
                            {tab === "rules" && (
                                <section
                                    aria-label="Subagent system prompt preview"
                                    className="mt-2 rounded border border-editor-group-border p-2">
                                    <div className="mb-1 text-[11px] font-medium text-description">
                                        Example system prompt · Preview only
                                    </div>
                                    <pre className="m-0 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-foreground">
                                        {systemPreview}
                                    </pre>
                                </section>
                            )}
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-editor-group-border pt-3 text-[11px] text-description">
                            <span>
                                <output aria-label="Injected rules">{activeCount("rules")}</output> rules injected
                            </span>
                            <span>
                                <output aria-label="Active skills">{activeCount("skills")}</output> skills active
                            </span>
                            <span>
                                <output aria-label="Active workflows">{activeCount("workflows")}</output> workflows active
                            </span>
                            <span>
                                <output aria-label="Active MCP items">{activeCount("mcp")}</output> MCP items active
                            </span>
                            <Button
                                className="ml-auto"
                                onClick={() => {
                                    setTools(new Set(initialTools))
                                    setSelection(new Set(INITIAL_SELECTION))
                                    setQuery("")
                                }}
                                size="xs"
                                variant="ghost">
                                Reset preview
                            </Button>
                        </div>
                    </div>
                )}
            </section>
            <p className="mt-2 text-[11px] text-description">
                Counts show active / selected. Tool access and capability choices are separate.
            </p>
        </main>
    )
}
