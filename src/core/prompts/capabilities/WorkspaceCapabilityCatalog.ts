import path from "node:path"
import { Logger } from "@shared/services/Logger"
import { hashStableJson } from "@shared/stable-json"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import {
    type CapabilitySourceCollectionInput,
    type CapabilitySourceSnapshot,
    type CollectCapabilitiesInput,
    collectCapabilitySources,
    projectCapabilities,
} from "./CapabilitiesAggregator"
import type { CapabilitiesSnapshot, CapabilityEntry } from "./types"

export interface WorkspaceCapabilityCatalogSnapshot {
    readonly revision: number
    readonly sources: CapabilitySourceSnapshot
}

export interface WorkspaceCapabilityCatalogSubscription {
    dispose(): void
}

export interface WorkspaceCapabilityCatalogDeps {
    readonly collectSources?: (input: CapabilitySourceCollectionInput) => Promise<CapabilitySourceSnapshot>
}

type WorkspaceCapabilityCatalogListener = (snapshot: WorkspaceCapabilityCatalogSnapshot) => void

interface CatalogEntry {
    readonly key: string
    readonly workspace: string
    readonly input: CapabilitySourceCollectionInput
    revision: number
    dirty: boolean
    snapshot?: WorkspaceCapabilityCatalogSnapshot
    inFlight?: Promise<WorkspaceCapabilityCatalogSnapshot>
    lastInvalidationToken?: object
}

function workspaceIdentity(cwd: string): string {
    return path.resolve(cwd)
}

function sourceInput(input: CollectCapabilitiesInput): CapabilitySourceCollectionInput {
    return {
        cwd: workspaceIdentity(input.cwd),
        remoteSkillEntries: input.remoteSkillEntries?.map((entry) => ({ ...entry })),
        remoteWorkflowEntries: input.remoteWorkflowEntries?.map((entry) => ({ ...entry })),
    }
}

function sourceKey(input: CapabilitySourceCollectionInput): string {
    return `${workspaceIdentity(input.cwd)}\u0000${hashStableJson({
        remoteSkills: input.remoteSkillEntries ?? [],
        remoteWorkflows: input.remoteWorkflowEntries ?? [],
    })}`
}

function immutableEntry(entry: CapabilityEntry): CapabilityEntry {
    return Object.freeze({
        ...entry,
        ...(entry.tools === undefined ? {} : { tools: Object.freeze([...entry.tools]) }),
    })
}

function immutableSources(sources: CapabilitySourceSnapshot): CapabilitySourceSnapshot {
    return Object.freeze({
        skills: Object.freeze(
            sources.skills.map((source) =>
                Object.freeze({
                    skill: Object.freeze({ ...source.skill }),
                    entry: immutableEntry(source.entry),
                }),
            ),
        ),
        workflows: Object.freeze(
            sources.workflows.map((source) => Object.freeze({ ...source, entry: immutableEntry(source.entry) })),
        ),
        subagents: Object.freeze(
            sources.subagents.map((source) => Object.freeze({ ...source, entry: immutableEntry(source.entry) })),
        ),
    })
}

/** Process-owned capability source catalog shared by every task in one workspace. */
export class WorkspaceCapabilityCatalogRegistry {
    private readonly collectSources: (input: CapabilitySourceCollectionInput) => Promise<CapabilitySourceSnapshot>
    private readonly entries = new Map<string, CatalogEntry>()
    private readonly listeners = new Map<string, Set<WorkspaceCapabilityCatalogListener>>()

    constructor(deps: WorkspaceCapabilityCatalogDeps = {}) {
        this.collectSources = deps.collectSources ?? collectCapabilitySources
    }

    async getCapabilities(input: CollectCapabilitiesInput): Promise<CapabilitiesSnapshot> {
        const snapshot = await this.getSourceSnapshot(input)
        return projectCapabilities(snapshot.sources, input)
    }

    async getSourceSnapshot(input: CollectCapabilitiesInput): Promise<WorkspaceCapabilityCatalogSnapshot> {
        const canonical = sourceInput(input)
        const key = sourceKey(canonical)
        let entry = this.entries.get(key)
        if (!entry) {
            entry = {
                key,
                workspace: workspaceIdentity(canonical.cwd),
                input: canonical,
                revision: 0,
                dirty: true,
            }
            this.entries.set(key, entry)
        }
        if (entry.inFlight) return entry.inFlight
        if (!entry.snapshot || entry.dirty) return this.ensureFresh(entry)
        return entry.snapshot
    }

    /** Mark canonical filesystem sources dirty; concurrent task signals share one refresh. */
    invalidateWorkspace(cwd: string, token?: object): void {
        const workspace = workspaceIdentity(cwd)
        for (const entry of this.entries.values()) {
            if (entry.workspace !== workspace) continue
            if (token && entry.lastInvalidationToken === token) continue
            entry.lastInvalidationToken = token
            entry.dirty = true
            void this.ensureFresh(entry).catch((error) => {
                Logger.error(`[WorkspaceCapabilityCatalog] Failed to refresh ${workspace}:`, error)
            })
        }
    }

    subscribe(cwd: string, listener: WorkspaceCapabilityCatalogListener): WorkspaceCapabilityCatalogSubscription {
        const workspace = workspaceIdentity(cwd)
        let listeners = this.listeners.get(workspace)
        if (!listeners) {
            listeners = new Set()
            this.listeners.set(workspace, listeners)
        }
        listeners.add(listener)
        let disposed = false
        return {
            dispose: () => {
                if (disposed) return
                disposed = true
                listeners?.delete(listener)
                if (listeners?.size === 0) this.listeners.delete(workspace)
            },
        }
    }

    disposeAll(): void {
        this.entries.clear()
        this.listeners.clear()
    }

    private ensureFresh(entry: CatalogEntry): Promise<WorkspaceCapabilityCatalogSnapshot> {
        if (entry.inFlight) return entry.inFlight
        const run = this.refreshLoop(entry)
        const settled = run.finally(() => {
            if (entry.inFlight === settled) entry.inFlight = undefined
        })
        entry.inFlight = settled
        return settled
    }

    private async refreshLoop(entry: CatalogEntry): Promise<WorkspaceCapabilityCatalogSnapshot> {
        do {
            entry.dirty = false
            const previous = entry.snapshot
            const startedAt = performance.now()
            try {
                const sources = immutableSources(await this.collectSources(entry.input))
                entry.revision += 1
                entry.snapshot = Object.freeze({ revision: entry.revision, sources })
                const durationMs = performance.now() - startedAt
                recordPerfPhase(PerfDomain.Capability, "catalog_refresh", durationMs, {
                    revision: entry.revision,
                    initial: previous === undefined,
                    skills: sources.skills.length,
                    workflows: sources.workflows.length,
                    subagents: sources.subagents.length,
                })
                Logger.debug(
                    `[CapabilityCatalogPerf] phase=refresh revision=${entry.revision} initial=${previous === undefined} durationMs=${Math.round(durationMs)} skills=${sources.skills.length} workflows=${sources.workflows.length} subagents=${sources.subagents.length}`,
                )
                if (previous) this.publish(entry.workspace, entry.snapshot)
            } catch (error) {
                entry.dirty = true
                throw error
            }
        } while (entry.dirty)
        if (!entry.snapshot) throw new Error(`Capability catalog ${entry.key} did not produce a snapshot`)
        return entry.snapshot
    }

    private publish(workspace: string, snapshot: WorkspaceCapabilityCatalogSnapshot): void {
        for (const listener of [...(this.listeners.get(workspace) ?? [])]) {
            try {
                listener(snapshot)
            } catch (error) {
                Logger.error("[WorkspaceCapabilityCatalog] Subscriber failed:", error)
            }
        }
    }
}

let sharedRegistry: WorkspaceCapabilityCatalogRegistry | undefined

export function getWorkspaceCapabilityCatalogRegistry(): WorkspaceCapabilityCatalogRegistry {
    sharedRegistry ??= new WorkspaceCapabilityCatalogRegistry()
    return sharedRegistry
}
