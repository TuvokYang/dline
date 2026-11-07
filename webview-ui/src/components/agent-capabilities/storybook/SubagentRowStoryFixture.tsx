import { Empty } from "@shared/proto/dline/common"
import {
    AvailableToolsResponse,
    RefreshedSubagents,
    SubagentCapabilitiesResponse,
    SubagentInfo,
    UpdateSubagentConfigRequest,
} from "@shared/proto/dline/file"
import { ApiProfile, ApiProfilesResponse } from "@shared/proto/dline/profile"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { FileServiceClient } from "@/services/grpc-client"
import SubagentRow from "../SubagentRow"

// Story-only production editor: the real SubagentRow against an in-memory RPC mock.
// Every read and write stays inside this fixture's memory: no real subagent file
// is written and no subagent (Runner) is launched. Do not copy this wiring into UI.

const AGENT_PATH = "/workspace/.agents/subagents/reviewer.yml"
const AGENT = SubagentInfo.create({
    name: "reviewer",
    description: "Review changes with a focused set of tools and instructions.",
    path: AGENT_PATH,
    enabled: true,
    tools: ["read_file", "search_files", "load_mcp", "use_mcp_tool"],
    skills: ["use-vitest", "gone"],
    workflows: ["e2e-validation"],
    rules: [{ scope: "workspace", path: "review.md" }],
    mcp: [],
})

const TOOL_GROUPS = [
    {
        name: "Read & explore",
        tools: [
            { name: "read_file", description: "Read files and directories", isReadOnly: true },
            { name: "search_files", description: "Search files by pattern", isReadOnly: true },
            { name: "attempt_completion", description: "Finish the subagent run", isReadOnly: true, required: true },
        ],
    },
    {
        name: "Load instructions",
        tools: [
            { name: "load_skill", description: "Load an available skill", isReadOnly: true },
            { name: "load_workflow", description: "Load an available workflow", isReadOnly: true },
        ],
    },
    {
        name: "MCP access",
        tools: [
            { name: "load_mcp", description: "Connect to an MCP server", isReadOnly: true },
            { name: "use_mcp_tool", description: "Call an MCP tool", isReadOnly: true },
            { name: "access_mcp_resource", description: "Read an MCP resource", isReadOnly: true },
        ],
    },
]

const CAPABILITIES = SubagentCapabilitiesResponse.create({
    rules: [
        {
            name: "review.md",
            description: "Keep reviews focused on observable behavior and concrete evidence.",
            scope: "workspace",
            path: "review.md",
            available: true,
        },
        {
            name: "policy.md",
            description: "Company-wide review policy.",
            scope: "remote",
            path: "policy.md",
            required: true,
            available: true,
        },
    ],
    skills: [
        {
            name: "use-vitest",
            description: "Run focused tests and diagnose failures.",
            scope: "workspace",
            path: "use-vitest/SKILL.md",
            available: true,
        },
        {
            name: "review-checklist",
            description: "Check changes against the team's review checklist.",
            scope: "global",
            path: "review-checklist/SKILL.md",
            available: true,
        },
    ],
    workflows: [
        {
            name: "e2e-validation",
            description: "Select and run bounded end-to-end validation.",
            scope: "workspace",
            path: "e2e.md",
            available: true,
        },
    ],
    mcp: [
        {
            name: "docs@ws",
            displayName: "Docs",
            available: true,
            tools: [{ name: "query", description: "Find documentation for a library." }],
            resources: [
                { uri: "repository://instructions", name: "Instructions", description: "Repository instructions resource." },
            ],
        },
    ],
})

const PROFILES = [
    ApiProfile.create({ id: "review", name: "review-profile", enabled: true, usedFor: ["subagents"] }),
    ApiProfile.create({ id: "fast", name: "fast-profile", enabled: true, usedFor: ["subagents"] }),
    ApiProfile.create({ id: "parent", name: "parent-only", enabled: true, usedFor: ["act"] }),
]

interface PatchRecord {
    subagentPath: string
    tools: string[]
    skills: string[]
    workflows: string[]
    rules: { scope: string; path: string }[]
    mcp: { server: string; tools: string[]; resources: string[] }[]
    profile: string | null
    replaceTools: boolean
    replaceSkills: boolean
    replaceWorkflows: boolean
    replaceRules: boolean
    replaceMcp: boolean
}

interface StoredAgentJson {
    name: string
    path: string
    enabled: boolean
    tools: string[]
    skills: string[]
    workflows: string[]
    rules: { scope: string; path: string }[]
    mcp: { server: string; tools: string[]; resources: string[] }[]
    profile: string | null
}

declare global {
    interface Window {
        __SUBAGENT_ROW_FIXTURE__?: {
            getPatches: () => PatchRecord[]
            getStoredAgent: () => StoredAgentJson | undefined
        }
    }
}

// In-memory "file": the stored agent is the authoritative YAML stand-in and every
// successful updateSubagentConfig write is recorded as a JSON patch for assertions.
const stored = new Map<string, SubagentInfo>([[AGENT_PATH, AGENT]])
const patches: PatchRecord[] = []
const heldSaves: {
    request: UpdateSubagentConfigRequest
    // The held call resolves with the same Empty the real RPC returns, so the
    // deferred resolver and the awaited promise share one type.
    resolve: (value: Empty) => void
    reject: (error: Error) => void
}[] = []
let failNextSave = false
let holdNextSave = false

function record(request: UpdateSubagentConfigRequest): PatchRecord {
    return {
        subagentPath: request.subagentPath,
        tools: [...request.tools],
        skills: [...request.skills],
        workflows: [...request.workflows],
        rules: request.rules.map((rule) => ({ scope: rule.scope, path: rule.path })),
        mcp: request.mcp.map((entry) => ({ server: entry.server, tools: [...entry.tools], resources: [...entry.resources] })),
        profile: request.profile ?? null,
        replaceTools: request.replaceTools,
        replaceSkills: request.replaceSkills,
        replaceWorkflows: request.replaceWorkflows,
        replaceRules: request.replaceRules,
        replaceMcp: request.replaceMcp,
    }
}

function applyPatch(current: SubagentInfo, request: UpdateSubagentConfigRequest): SubagentInfo {
    return SubagentInfo.create({
        ...current,
        ...(request.replaceTools ? { tools: [...request.tools] } : {}),
        ...(request.replaceRules ? { rules: request.rules.map((rule) => ({ scope: rule.scope, path: rule.path })) } : {}),
        ...(request.replaceSkills ? { skills: [...request.skills] } : {}),
        ...(request.replaceWorkflows ? { workflows: [...request.workflows] } : {}),
        ...(request.replaceMcp
            ? {
                  mcp: request.mcp.map((entry) => ({
                      server: entry.server,
                      tools: [...entry.tools],
                      resources: [...entry.resources],
                  })),
              }
            : {}),
        ...(request.profile !== undefined ? { profile: request.profile || undefined } : {}),
    })
}

function executeSave(request: UpdateSubagentConfigRequest): Promise<Empty> {
    if (failNextSave) {
        failNextSave = false
        return Promise.reject(new Error("Simulated save failure (story control)"))
    }
    const current = stored.get(request.subagentPath)
    if (!current) return Promise.reject(new Error("Unknown subagent path"))
    stored.set(request.subagentPath, applyPatch(current, request))
    patches.push(record(request))
    return Promise.resolve(Empty.create({}))
}

const releaseHeldSave = () => {
    const held = heldSaves.shift()
    if (!held) return
    void executeSave(held.request).then(held.resolve, held.reject)
}

function plainAgent(agent: SubagentInfo | undefined): StoredAgentJson | undefined {
    if (!agent) return undefined
    return {
        name: agent.name,
        path: agent.path,
        enabled: agent.enabled,
        tools: [...agent.tools],
        skills: [...agent.skills],
        workflows: [...agent.workflows],
        rules: agent.rules.map((rule) => ({ scope: rule.scope, path: rule.path })),
        mcp: agent.mcp.map((entry) => ({ server: entry.server, tools: [...entry.tools], resources: [...entry.resources] })),
        profile: agent.profile ?? null,
    }
}

function clonePatches(): PatchRecord[] {
    return patches.map((patch) => ({
        ...patch,
        tools: [...patch.tools],
        skills: [...patch.skills],
        workflows: [...patch.workflows],
        rules: patch.rules.map((rule) => ({ ...rule })),
        mcp: patch.mcp.map((entry) => ({ ...entry, tools: [...entry.tools], resources: [...entry.resources] })),
    }))
}

export function SubagentRowStoryFixture() {
    const [ready, setReady] = useState(false)
    const [mountId, setMountId] = useState(0)

    useEffect(() => {
        const originals = {
            getAvailableTools: FileServiceClient.getAvailableTools,
            getSubagentCapabilities: FileServiceClient.getSubagentCapabilities,
            getApiProfiles: FileServiceClient.getApiProfiles,
            updateSubagentConfig: FileServiceClient.updateSubagentConfig,
            refreshSubagents: FileServiceClient.refreshSubagents,
            openFile: FileServiceClient.openFile,
            deleteSubagentFile: FileServiceClient.deleteSubagentFile,
        }
        FileServiceClient.getAvailableTools = async () => AvailableToolsResponse.create({ groups: TOOL_GROUPS })
        FileServiceClient.getSubagentCapabilities = async () => CAPABILITIES
        FileServiceClient.getApiProfiles = async () => ApiProfilesResponse.create({ profiles: PROFILES })
        FileServiceClient.updateSubagentConfig = (request) => {
            if (holdNextSave) {
                holdNextSave = false
                return new Promise<Empty>((resolve, reject) => heldSaves.push({ request, resolve, reject }))
            }
            return executeSave(request)
        }
        FileServiceClient.refreshSubagents = async () =>
            RefreshedSubagents.create({ globalSubagents: [], localSubagents: [...stored.values()] })
        FileServiceClient.openFile = async () => Empty.create({})
        FileServiceClient.deleteSubagentFile = async () => ({ globalSubagentsToggles: {}, localSubagentsToggles: {} })
        window.__SUBAGENT_ROW_FIXTURE__ = {
            getPatches: () => clonePatches(),
            getStoredAgent: () => plainAgent(stored.get(AGENT_PATH)),
        }
        setReady(true)
        return () => {
            FileServiceClient.getAvailableTools = originals.getAvailableTools
            FileServiceClient.getSubagentCapabilities = originals.getSubagentCapabilities
            FileServiceClient.getApiProfiles = originals.getApiProfiles
            FileServiceClient.updateSubagentConfig = originals.updateSubagentConfig
            FileServiceClient.refreshSubagents = originals.refreshSubagents
            FileServiceClient.openFile = originals.openFile
            FileServiceClient.deleteSubagentFile = originals.deleteSubagentFile
            delete window.__SUBAGENT_ROW_FIXTURE__
        }
    }, [])

    return (
        <main className="mx-auto max-w-[720px] p-4 text-foreground" data-testid="subagent-row-fixture">
            <div className="mb-3 rounded border border-editor-group-border bg-text-block-background p-3 text-xs">
                <div className="font-semibold">Storybook fixture · in-memory RPC mock</div>
                <p className="mb-0 mt-1 text-description">
                    Renders the production SubagentRow with its RPC methods replaced by this fixture's in-memory mock: nothing is
                    written to a real subagent file and no subagent (Runner) is launched. Do not copy this mock wiring into
                    production UI.
                </p>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                <Button
                    onClick={() => {
                        failNextSave = true
                    }}
                    size="xs"
                    variant="secondary">
                    Fail next save
                </Button>
                <Button
                    onClick={() => {
                        holdNextSave = true
                    }}
                    size="xs"
                    variant="secondary">
                    Hold next save
                </Button>
                <Button onClick={releaseHeldSave} size="xs" variant="secondary">
                    Release held save
                </Button>
                <Button onClick={() => setMountId((current) => current + 1)} size="xs" variant="secondary">
                    Reopen editor
                </Button>
            </div>
            {ready && (
                // Reopen must mount the row from the stored (in-memory YAML) agent, so a
                // remounted editor reads the acknowledged state instead of a stale prop.
                <SubagentRow
                    agent={stored.get(AGENT_PATH) ?? AGENT}
                    isGlobal={false}
                    key={mountId}
                    onDelete={() => undefined}
                    onToggle={async () => undefined}
                />
            )}
        </main>
    )
}
