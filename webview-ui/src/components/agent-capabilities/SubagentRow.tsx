import { EmptyRequest, StringRequest } from "@shared/proto/dline/common"
import {
    DeleteSubagentRequest,
    SubagentCapabilitiesResponse,
    SubagentCapabilityInfo,
    SubagentInfo,
    ToolGroup,
} from "@shared/proto/dline/file"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { DlineDefaultTool as Tool } from "@shared/tools"
import { ChevronDownIcon, ChevronRightIcon, LockKeyhole, PenIcon, Search, Trash2Icon } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { nativeSelectOptionStyle, nativeSelectStyle } from "@/components/ui/native-select-theme"
import { Switch } from "@/components/ui/switch"
import { FileServiceClient } from "@/services/grpc-client"
import useSubagentConfig, { type SubagentConfig } from "./useSubagentConfig"

interface SubagentRowProps {
    agent: SubagentInfo
    isGlobal: boolean
    onToggle: (path: string, enabled: boolean) => Promise<void> | void
    onDelete: () => void
}

type ResourceTab = "rules" | "skills" | "workflows" | "mcp"
type Tab = "tools" | ResourceTab
interface Choice {
    key: string
    name: string
    description: string
    source: string
    scope?: string
    path?: string
    server?: string
    kind?: "tools" | "resources"
    value: string
    required: boolean
    available: boolean
    unavailableReason?: string
    selected: boolean
    requires: string[]
}

const TABS: Tab[] = ["tools", "rules", "skills", "workflows", "mcp"]
const LABELS: Record<Tab, string> = { tools: "Tools", rules: "Rules", skills: "Skills", workflows: "Workflows", mcp: "MCP" }
const PREREQUISITES: Record<Tab, string[]> = {
    tools: [],
    rules: [],
    skills: [Tool.LOAD_SKILL],
    workflows: [Tool.LOAD_WORKFLOW],
    mcp: [Tool.LOAD_MCP, Tool.MCP_USE, Tool.MCP_ACCESS],
}
const ruleKey = (rule: { scope: string; path: string }) => JSON.stringify([rule.scope, rule.path])
const mcpKey = (server: string, kind: string, value: string) => JSON.stringify([server, kind, value])
const mcpSource = (name: string, displayName?: string) =>
    displayName && displayName !== name ? `${displayName} (${name})` : name
const sourceName = (scope: string) => (scope ? scope[0].toUpperCase() + scope.slice(1) : "Unknown source")
const changeMembership = (values: string[], value: string, checked: boolean) =>
    checked ? [...new Set([...values, value])] : values.filter((item) => item !== value)

/** Merge the read-only directory with selections, including disappeared entries. */
function resourceChoices(tab: Exclude<ResourceTab, "mcp">, catalog: SubagentCapabilityInfo[], config: SubagentConfig): Choice[] {
    const choices = new Map<string, Choice>()
    for (const item of catalog) {
        const key = tab === "rules" ? ruleKey(item) : item.name
        choices.set(key, {
            ...item,
            key,
            value: item.name,
            source: sourceName(item.scope),
            selected: tab === "rules" ? config.rules.some((rule) => ruleKey(rule) === key) : config[tab].includes(item.name),
            requires: PREREQUISITES[tab],
        })
    }
    const selected =
        tab === "rules"
            ? config.rules.map((rule) => ({ ...rule, name: rule.path, key: ruleKey(rule) }))
            : config[tab].map((name) => ({ name, scope: "", path: "", key: name }))
    for (const item of selected) {
        if (choices.has(item.key)) continue
        choices.set(item.key, {
            ...item,
            value: item.name,
            description: "This saved selection is no longer in the capability directory.",
            source: item.scope ? sourceName(item.scope) : "Unavailable selections",
            required: false,
            available: false,
            unavailableReason: "Selected capability is missing or unavailable.",
            selected: true,
            requires: PREREQUISITES[tab],
        })
    }
    return [...choices.values()]
}

function mcpChoices(catalog: SubagentCapabilitiesResponse["mcp"], config: SubagentConfig): Choice[] {
    const choices = new Map<string, Choice>()
    for (const server of catalog) {
        const selected = config.mcp.filter((item) => item.server === server.name)
        const source = mcpSource(server.name, server.displayName)
        for (const kind of ["tools", "resources"] as const) {
            const items =
                kind === "tools"
                    ? server.tools.map((tool) => ({ ...tool, value: tool.name }))
                    : server.resources.map((resource) => ({ ...resource, value: resource.uri }))
            for (const item of items) {
                const key = mcpKey(server.name, kind, item.value)
                choices.set(key, {
                    key,
                    name: item.name || item.value,
                    value: item.value,
                    description: item.description,
                    source,
                    server: server.name,
                    kind,
                    required: false,
                    available: server.available,
                    unavailableReason: server.unavailableReason,
                    selected: selected.some((selection) => selection[kind].includes(item.value)),
                    requires: kind === "tools" ? [Tool.LOAD_MCP, Tool.MCP_USE] : [Tool.MCP_ACCESS],
                })
            }
        }
    }
    for (const selection of config.mcp) {
        for (const kind of ["tools", "resources"] as const) {
            for (const value of selection[kind]) {
                const key = mcpKey(selection.server, kind, value)
                if (choices.has(key)) continue
                const server = catalog.find((item) => item.name === selection.server)
                choices.set(key, {
                    key,
                    name: value,
                    value,
                    description: "This saved MCP selection is no longer advertised by its server.",
                    source: mcpSource(selection.server, server?.displayName),
                    server: selection.server,
                    kind,
                    required: false,
                    available: false,
                    unavailableReason: server?.unavailableReason || "Selected MCP server or item is missing or unavailable.",
                    selected: true,
                    requires: kind === "tools" ? [Tool.LOAD_MCP, Tool.MCP_USE] : [Tool.MCP_ACCESS],
                })
            }
        }
    }
    return [...choices.values()]
}

function choiceLabel(tab: Tab, item: Choice) {
    if (tab === "rules") return `Use rule ${item.scope}/${item.path}`
    if (tab === "skills") return `Use skill ${item.name}`
    if (tab === "workflows") return `Use workflow ${item.name}`
    if (tab === "mcp") return `Use MCP ${item.kind === "resources" ? "resource" : "tool"} ${item.server}/${item.value}`
    return `Use ${item.name}`
}

function SelectionRow({
    tab,
    item,
    missing,
    disabled,
    onChange,
}: {
    tab: Tab
    item: Choice
    missing: string[]
    disabled: boolean
    onChange: (checked: boolean) => void
}) {
    const id = useId()
    const locked = disabled || item.required || !item.available || missing.length > 0
    return (
        <div className="rounded px-2 py-2 hover:bg-text-block-background">
            <label className={`flex gap-2.5 ${locked ? "opacity-70" : "cursor-pointer"}`}>
                <input
                    aria-describedby={`${id}-description`}
                    aria-label={choiceLabel(tab, item)}
                    checked={item.required || item.selected}
                    className="mt-0.5 shrink-0 accent-[var(--vscode-button-background)]"
                    disabled={locked}
                    onChange={(event) => onChange(event.target.checked)}
                    type="checkbox"
                />
                <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="break-all text-xs font-medium">{item.name}</span>
                        {item.kind && (
                            <span className="text-[10px] text-description">{item.kind === "tools" ? "Tool" : "Resource"}</span>
                        )}
                        <span className="ml-auto text-[10px] text-description">{item.source}</span>
                    </span>
                    <span className="mt-1 block text-xs text-description" id={`${id}-description`}>
                        {item.description}
                        {item.path && item.path !== item.name && <span className="block break-all">{item.path}</span>}
                        {item.kind === "resources" && item.value !== item.name && (
                            <span className="block break-all">{item.value}</span>
                        )}
                        {item.required && <span className="block">Required by policy · not saved as an ordinary selection</span>}
                        {!item.available && (
                            <span className="block text-warning">Unavailable: {item.unavailableReason || "Not available"}</span>
                        )}
                        {missing.length > 0 && <span className="block text-warning">Requires {missing.join(" + ")}</span>}
                    </span>
                </span>
            </label>
            {!item.required && item.selected && !item.available && (
                <Button
                    aria-label={`Remove unavailable selection: ${choiceLabel(tab, item)}`}
                    className="ml-5 mt-1"
                    disabled={disabled}
                    onClick={() => onChange(false)}
                    size="xs"
                    variant="ghost">
                    Remove unavailable selection
                </Button>
            )}
        </div>
    )
}

/** Production editor: independent directories, bounded reads, field-only patches. */
const SubagentRowContent: React.FC<SubagentRowProps> = ({ agent, isGlobal, onToggle, onDelete }) => {
    const id = useId()
    const [expanded, setExpanded] = useState(false)
    const [tab, setTab] = useState<Tab>("tools")
    const [query, setQuery] = useState("")
    const [reload, setReload] = useState(0)
    const [toolGroups, setToolGroups] = useState<ToolGroup[]>([])
    const [capabilities, setCapabilities] = useState<SubagentCapabilitiesResponse>({
        rules: [],
        skills: [],
        workflows: [],
        mcp: [],
    })
    const [profiles, setProfiles] = useState<ApiProfile[]>([])
    const [loading, setLoading] = useState({ tools: true, capabilities: true, profiles: true })
    const [errors, setErrors] = useState<Partial<Record<"tools" | "capabilities" | "profiles", string>>>({})
    const { config, edit, saving, saved, error, refreshError, refresh } = useSubagentConfig(agent)
    const [pendingEnabled, setPendingEnabled] = useState<boolean>()
    const [actionError, setActionError] = useState<string>()
    const toggleIntentRef = useRef(0)
    const mountedRef = useRef(true)
    const displayedEnabled = pendingEnabled ?? agent.enabled

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    useEffect(() => {
        if (pendingEnabled === agent.enabled) setPendingEnabled(undefined)
    }, [agent.enabled, pendingEnabled])

    useEffect(() => {
        if (!expanded) return
        let cancelled = false
        setLoading({ tools: true, capabilities: true, profiles: true })
        setErrors({})
        const failed = (kind: "tools" | "capabilities" | "profiles", cause: unknown) => {
            if (!cancelled)
                setErrors((current) => ({ ...current, [kind]: cause instanceof Error ? cause.message : String(cause) }))
        }
        const done = (kind: "tools" | "capabilities" | "profiles") => {
            if (!cancelled) setLoading((current) => ({ ...current, [kind]: false }))
        }
        FileServiceClient.getAvailableTools({} as EmptyRequest)
            .then((response) => {
                if (!cancelled) setToolGroups(response.groups || [])
            })
            .catch((cause) => failed("tools", cause))
            .finally(() => done("tools"))
        FileServiceClient.getSubagentCapabilities({ subagentPath: agent.path })
            .then((response) => {
                if (!cancelled) setCapabilities(response)
            })
            .catch((cause) => failed("capabilities", cause))
            .finally(() => done("capabilities"))
        FileServiceClient.getApiProfiles({} as EmptyRequest)
            .then((response) => {
                if (!cancelled) {
                    setProfiles(
                        (response.profiles || []).filter((profile) => profile.enabled && profile.usedFor.includes("subagents")),
                    )
                }
            })
            .catch((cause) => failed("profiles", cause))
            .finally(() => done("profiles"))
        return () => {
            cancelled = true
        }
    }, [expanded, agent.path, reload])

    const allTools = toolGroups.flatMap((group) => group.tools)
    const requiredTools = new Set(allTools.filter((tool) => tool.required).map((tool) => tool.name))
    const effectiveTools = new Set(
        allTools.filter((tool) => tool.required || config.tools.includes(tool.name)).map((tool) => tool.name),
    )
    const tools: Choice[] = toolGroups.flatMap((group) =>
        group.tools.map((tool) => ({
            key: tool.name,
            name: tool.name,
            value: tool.name,
            description: tool.description,
            source: group.name,
            required: tool.required,
            available: true,
            selected: config.tools.includes(tool.name),
            requires: [],
        })),
    )
    for (const name of config.tools) {
        if (tools.some((tool) => tool.value === name)) continue
        tools.push({
            key: name,
            name,
            value: name,
            source: "Unavailable selections",
            description: "This saved tool is no longer in the tool directory.",
            required: false,
            available: false,
            selected: true,
            requires: [],
        })
    }
    const inventory: Record<Tab, Choice[]> = {
        tools,
        rules: resourceChoices("rules", capabilities.rules, config),
        skills: resourceChoices("skills", capabilities.skills, config),
        workflows: resourceChoices("workflows", capabilities.workflows, config),
        mcp: mcpChoices(capabilities.mcp, config),
    }
    const missingTools = (item: Choice) => item.requires.filter((tool) => !effectiveTools.has(tool))
    const counts = (kind: Tab) => ({
        selected: inventory[kind].filter((item) => !item.required && item.selected).length,
        active: inventory[kind].filter(
            (item) => !item.required && item.selected && item.available && missingTools(item).length === 0,
        ).length,
        required: inventory[kind].filter((item) => item.required).length,
    })
    const setTool = (name: string, checked: boolean) => {
        if (requiredTools.has(name)) return
        edit("tools", (current) => changeMembership(current, name, checked).filter((tool) => !requiredTools.has(tool)))
    }
    const setChoice = (item: Choice, checked: boolean) => {
        if (item.required) return
        if (tab === "tools") return setTool(item.value, checked)
        if (tab === "rules") {
            const required = new Set(inventory.rules.filter((rule) => rule.required).map((rule) => rule.key))
            edit("rules", (current) => {
                const next = current.filter((rule) => ruleKey(rule) !== item.key && !required.has(ruleKey(rule)))
                return checked ? [...next, { scope: item.scope || "", path: item.path || "" }] : next
            })
        } else if (tab === "skills" || tab === "workflows") {
            const required = new Set(
                inventory[tab].filter((capability) => capability.required).map((capability) => capability.value),
            )
            edit(tab, (current) => changeMembership(current, item.value, checked).filter((name) => !required.has(name)))
        } else if (item.server && item.kind) {
            const server = item.server
            const kind = item.kind
            edit("mcp", (current) => {
                // Preserve every unrelated server, exact tool name, and exact URI.
                const existing = current.filter((selection) => selection.server === server)
                const selection = {
                    server,
                    tools: [...new Set(existing.flatMap((entry) => entry.tools))],
                    resources: [...new Set(existing.flatMap((entry) => entry.resources))],
                }
                selection[kind] = changeMembership(selection[kind], item.value, checked)
                const next = current.filter((entry) => entry.server !== server)
                if (selection.tools.length || selection.resources.length) next.push(selection)
                return next
            })
        }
    }
    const handleToggle = async () => {
        const nextEnabled = !displayedEnabled
        const intent = ++toggleIntentRef.current
        setPendingEnabled(nextEnabled)
        setActionError(undefined)
        try {
            await onToggle(agent.path, nextEnabled)
        } catch {
            if (mountedRef.current && toggleIntentRef.current === intent) {
                setPendingEnabled(undefined)
                setActionError("Could not change the subagent's enabled state.")
            }
        }
    }
    const handleDelete = () => {
        setActionError(undefined)
        FileServiceClient.deleteSubagentFile(DeleteSubagentRequest.create({ subagentPath: agent.path, isGlobal }))
            .then(() => {
                if (mountedRef.current) onDelete()
            })
            .catch(() => {
                if (mountedRef.current) setActionError("Could not delete the subagent file.")
            })
    }
    const handleEdit = () => {
        FileServiceClient.openFile(StringRequest.create({ value: agent.path })).catch(() => {
            if (mountedRef.current) setActionError("Could not open the subagent file.")
        })
    }
    const changeTab = (next: Tab) => {
        setTab(next)
        setQuery("")
    }
    const matches = (item: Choice) =>
        [item.name, item.value, item.description, item.source, item.path, item.server]
            .join(" ")
            .toLowerCase()
            .includes(query.trim().toLowerCase())
    const visible = inventory[tab].filter(matches)
    const ordinary = visible.filter((item) => !item.required)
    const required = visible.filter((item) => item.required)
    const prerequisites = PREREQUISITES[tab].filter((tool) => !effectiveTools.has(tool))
    const catalogLoading = tab === "tools" ? loading.tools : loading.capabilities
    const catalogError = tab === "tools" ? errors.tools : errors.capabilities
    // Rules do not depend on either loaders or the tool directory being readable.
    const readOnly = catalogLoading || !!catalogError || (tab !== "rules" && (loading.tools || !!errors.tools))

    return (
        <div className="mb-2.5">
            <div className="flex items-center rounded bg-text-block-background px-2 py-2">
                <button
                    aria-controls={`${id}-configuration`}
                    aria-expanded={expanded}
                    aria-label={`Configure subagent ${agent.name}`}
                    className="mr-1 rounded p-0.5 hover:bg-input-background"
                    onClick={() => setExpanded(!expanded)}
                    type="button">
                    {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                </button>
                <span className="mr-1 flex min-w-0 flex-1 flex-wrap items-center" title={agent.path}>
                    <span className="ph-no-capture font-medium">{agent.name}</span>
                    <span className="ml-2 text-[10px] text-description">{isGlobal ? "Global" : "Workspace"} subagent</span>
                    {agent.description && (
                        <span className="ml-2 max-w-[200px] truncate text-xs text-description">{agent.description}</span>
                    )}
                    <span className="ml-2 text-xs text-description">
                        tools: {counts("tools").selected} + {requiredTools.size} required
                    </span>
                </span>
                <div className="flex items-center gap-2">
                    <Switch
                        aria-label={`Enable subagent ${agent.name}`}
                        checked={displayedEnabled}
                        className="mx-1"
                        onClick={handleToggle}
                    />
                    <Button
                        aria-label="Edit subagent file"
                        onClick={handleEdit}
                        size="xs"
                        title="Edit subagent file"
                        variant="icon">
                        <PenIcon />
                    </Button>
                    <Button
                        aria-label="Delete subagent file"
                        disabled={saving}
                        onClick={handleDelete}
                        size="xs"
                        title="Delete subagent file"
                        variant="icon">
                        <Trash2Icon />
                    </Button>
                </div>
            </div>
            {actionError && (
                <div className="mt-1 text-xs text-error" role="alert">
                    {actionError}
                </div>
            )}
            {expanded && (
                <section
                    aria-label={`${agent.name} configuration`}
                    className="ml-6 mt-1 rounded bg-input-background p-3"
                    id={`${id}-configuration`}>
                    <label className="mb-3 flex flex-col gap-1 text-xs" htmlFor={`${id}-profile`}>
                        <span className="font-medium">Profile</span>
                        <select
                            className="w-full rounded border p-1.5 text-xs"
                            disabled={loading.profiles || !!errors.profiles}
                            id={`${id}-profile`}
                            onChange={(event) => {
                                const profile = event.target.value
                                edit("profile", () => profile)
                            }}
                            style={nativeSelectStyle}
                            value={config.profile}>
                            <option style={nativeSelectOptionStyle} value="">
                                Default (act profile)
                            </option>
                            {config.profile && !profiles.some((profile) => profile.name === config.profile) && (
                                <option style={nativeSelectOptionStyle} value={config.profile}>
                                    {config.profile} (unavailable)
                                </option>
                            )}
                            {profiles.map((profile) => (
                                <option key={profile.id || profile.name} style={nativeSelectOptionStyle} value={profile.name}>
                                    {profile.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    {Object.entries(errors).length > 0 && (
                        <div className="mb-2 rounded border border-editor-group-border p-2 text-xs" role="alert">
                            {Object.entries(errors).map(([kind, message]) => (
                                <p className="my-1" key={kind}>
                                    Could not load {kind}: {message}
                                </p>
                            ))}
                            <Button onClick={() => setReload((current) => current + 1)} size="xs" variant="secondary">
                                Retry capability directories
                            </Button>
                        </div>
                    )}
                    <div aria-label="Capability categories" className="flex border-b border-editor-group-border" role="tablist">
                        {TABS.map((kind, index) => {
                            const count = counts(kind)
                            return (
                                <button
                                    aria-controls={`${id}-panel-${kind}`}
                                    aria-label={`${LABELS[kind]} (${count.active} active, ${count.selected} selected, ${count.required} required)`}
                                    aria-selected={tab === kind}
                                    className={`flex min-w-0 flex-1 flex-wrap items-center justify-center gap-1 border-0 border-b-2 bg-transparent px-1 py-2 text-xs ${tab === kind ? "border-link text-link" : "border-transparent text-description"}`}
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
                                        {count.active}/{count.selected}
                                    </span>
                                    {count.required > 0 && <span className="text-[10px]">+{count.required} required</span>}
                                </button>
                            )
                        })}
                    </div>
                    <div aria-labelledby={`${id}-tab-${tab}`} id={`${id}-panel-${tab}`} role="tabpanel" tabIndex={0}>
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
                            <p className="mb-2 text-xs text-description">
                                {tab === "rules"
                                    ? "Selected rules are injected directly into this subagent's system prompt. No loader tool is required."
                                    : tab === "mcp"
                                      ? "Choose individual MCP tools and exact resource URIs. Tools require load_mcp + use_mcp_tool; resources require only access_mcp_resource. Selection does not bypass approval."
                                      : `Choose which ${LABELS[tab].toLowerCase()} this subagent may load on demand, not up front.`}
                            </p>
                        )}
                        {prerequisites.length > 0 && !loading.tools && !errors.tools && (
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
                                    {prerequisites.map((tool) =>
                                        allTools.some((item) => item.name === tool) ? (
                                            <Button key={tool} onClick={() => setTool(tool, true)} size="xs" variant="secondary">
                                                Enable {tool}
                                            </Button>
                                        ) : (
                                            <span className="text-xs text-warning" key={tool}>
                                                Unavailable tool: {tool}
                                            </span>
                                        ),
                                    )}
                                </div>
                            </div>
                        )}
                        <div
                            aria-busy={catalogLoading}
                            aria-label={`${LABELS[tab]} directory`}
                            className="max-h-[280px] min-h-[120px] overflow-y-auto pr-1"
                            role="group">
                            {catalogLoading ? (
                                <p className="text-xs text-description" role="status">
                                    Loading available {LABELS[tab].toLowerCase()}...
                                </p>
                            ) : catalogError && visible.length === 0 ? (
                                <p className="text-xs text-description">Directory unavailable. Saved selections are unchanged.</p>
                            ) : visible.length === 0 ? (
                                <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 text-center text-description">
                                    <span className="text-xs">
                                        {query.trim()
                                            ? "No matching capabilities."
                                            : `No ${LABELS[tab].toLowerCase()} available.`}
                                    </span>
                                    <span className="max-w-[300px] text-[11px]">
                                        {query.trim()
                                            ? "Try another search. Hidden selections are unchanged."
                                            : "Discoverable candidates are independent of the parent task's selections."}
                                    </span>
                                </div>
                            ) : (
                                <>
                                    {required.length > 0 && (
                                        <section
                                            aria-label={`Required ${LABELS[tab]}`}
                                            className="mb-2 border-b border-editor-group-border pb-2">
                                            <h4 className="my-1 px-2 text-[11px] font-semibold text-description">
                                                Required by policy · separate from ordinary selections
                                            </h4>
                                            {required.map((item) => (
                                                <SelectionRow
                                                    disabled={readOnly}
                                                    item={item}
                                                    key={item.key}
                                                    missing={missingTools(item)}
                                                    onChange={() => undefined}
                                                    tab={tab}
                                                />
                                            ))}
                                        </section>
                                    )}
                                    {[...new Set(ordinary.map((item) => item.source))].map((source) => (
                                        <div className="mb-2" key={source}>
                                            <h4 className="my-1 border-b border-editor-group-border px-2 py-1.5 text-[11px] font-semibold text-description">
                                                {source}
                                            </h4>
                                            <div
                                                className={
                                                    tab === "tools" ? "grid grid-cols-1 min-[480px]:grid-cols-2" : undefined
                                                }>
                                                {ordinary
                                                    .filter((item) => item.source === source)
                                                    .map((item) => (
                                                        <SelectionRow
                                                            disabled={readOnly}
                                                            item={item}
                                                            key={item.key}
                                                            missing={missingTools(item)}
                                                            onChange={(checked) => setChoice(item, checked)}
                                                            tab={tab}
                                                        />
                                                    ))}
                                            </div>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-editor-group-border pt-3 text-[11px] text-description">
                        <span>
                            <output aria-label="Active rules">{counts("rules").active}</output> rules eligible for injection
                        </span>
                        <span>
                            <output aria-label="Active skills">{counts("skills").active}</output> skills active
                        </span>
                        <span>
                            <output aria-label="Active workflows">{counts("workflows").active}</output> workflows active
                        </span>
                        <span>
                            <output aria-label="Active MCP items">{counts("mcp").active}</output> MCP items active
                        </span>
                    </div>
                    <p className="my-2 text-[11px] text-description">
                        Counts show active / selected ordinary choices; required items are separate. Rule conditions, runtime
                        availability and real approval still apply. Changes apply to the next subagent run.
                    </p>
                </section>
            )}
            {(expanded || saving || error || refreshError) && (
                <div className="ml-6 mt-1">
                    <div
                        aria-label="Subagent configuration save status"
                        aria-live="polite"
                        className="text-xs text-description"
                        role="status">
                        {saving
                            ? "Saving subagent configuration..."
                            : error
                              ? "Some changes were not saved."
                              : refreshError
                                ? "Saved choices kept; refreshed configuration could not be verified."
                                : saved
                                  ? "Subagent configuration saved."
                                  : "No unsaved changes."}
                    </div>
                    {error && (
                        <div className="mt-1 text-xs text-error" role="alert">
                            {error}
                        </div>
                    )}
                    {refreshError && (
                        <div className="mt-1 text-xs text-error" role="alert">
                            {refreshError}
                            <Button className="ml-2" onClick={refresh} size="xs" variant="secondary">
                                Retry refreshed configuration
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

// Reset expansion, directory requests, toggle intents and save subscriptions when
// a recycled row receives a different path; old async results cannot affect it.
const SubagentRow: React.FC<SubagentRowProps> = (props) => <SubagentRowContent key={props.agent.path} {...props} />

export default SubagentRow
