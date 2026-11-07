import { EmptyRequest } from "@shared/proto/dline/common"
import { SubagentInfo, UpdateSubagentConfigRequest } from "@shared/proto/dline/file"
import { useEffect, useState, useSyncExternalStore } from "react"
import { FileServiceClient } from "@/services/grpc-client"

export interface SubagentConfig {
    tools: string[]
    rules: SubagentInfo["rules"]
    skills: string[]
    workflows: string[]
    mcp: SubagentInfo["mcp"]
    profile: string
}

type Field = keyof SubagentConfig
interface Intent {
    field: Field
    apply: (config: SubagentConfig) => SubagentConfig
}
interface Snapshot {
    config: SubagentConfig
    saving: boolean
    saved: boolean
    error?: string
    refreshError?: string
}

const FIELDS: Field[] = ["tools", "rules", "skills", "workflows", "mcp", "profile"]
const signature = (value: SubagentConfig[Field]) => JSON.stringify(value)
const readConfig = (agent: SubagentInfo): SubagentConfig => ({
    tools: agent.tools ?? [],
    rules: agent.rules ?? [],
    skills: agent.skills ?? [],
    workflows: agent.workflows ?? [],
    mcp: agent.mcp ?? [],
    profile: agent.profile ?? "",
})

/** Only the edited category carries replacement intent; [] explicitly clears it. */
function requestFor(path: string, field: Field, config: SubagentConfig): UpdateSubagentConfigRequest {
    const patch = { subagentPath: path }
    switch (field) {
        case "tools":
            return UpdateSubagentConfigRequest.create({ ...patch, tools: config.tools, replaceTools: true })
        case "rules":
            return UpdateSubagentConfigRequest.create({ ...patch, rules: config.rules, replaceRules: true })
        case "skills":
            return UpdateSubagentConfigRequest.create({ ...patch, skills: config.skills, replaceSkills: true })
        case "workflows":
            return UpdateSubagentConfigRequest.create({ ...patch, workflows: config.workflows, replaceWorkflows: true })
        case "mcp":
            return UpdateSubagentConfigRequest.create({ ...patch, mcp: config.mcp, replaceMcp: true })
        case "profile":
            return UpdateSubagentConfigRequest.create({ ...patch, profile: config.profile })
    }
}

// Private, short-lived save sessions, not a configuration authority. Mounted,
// in-flight and not-yet-acknowledged paths share a queue across close/reopen.
// Acknowledged idle sessions are discarded; YAML/agent props remain authoritative.
const sessions = new Map<string, SaveSession>()

class SaveSession {
    private confirmed: SubagentConfig
    private incoming: SubagentConfig
    private pending: Intent[] = []
    private listeners = new Set<() => void>()
    private draining = false
    private saved = false
    private error?: string
    private refreshError?: string
    private snapshot: Snapshot
    // Remember superseded write projections for the mounted session. Once a
    // value has been acknowledged, a later matching old prop is ambiguous:
    // it can be a stale refresh OR a genuine external revert. Verify that case
    // with one bounded YAML read instead of guessing from unversioned props.
    private acknowledgements = new Map<Field, Set<string>>()
    private acknowledged = new Set<Field>()
    private versions: Record<Field, number> = { tools: 0, rules: 0, skills: 0, workflows: 0, mcp: 0, profile: 0 }

    constructor(
        private readonly path: string,
        agent: SubagentInfo,
    ) {
        this.confirmed = readConfig(agent)
        this.incoming = this.confirmed
        this.snapshot = { config: this.confirmed, saving: false, saved: false }
    }

    getSnapshot = () => this.snapshot
    refresh = () => {
        void this.verifyIncoming(FIELDS)
    }

    subscribe = (listener: () => void) => {
        sessions.set(this.path, this)
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
            this.release()
        }
    }

    reconcile(agent: SubagentInfo) {
        const incoming = readConfig(agent)
        const ambiguous: Field[] = []
        let changed = false
        for (const field of FIELDS) {
            const value = signature(incoming[field])
            const acknowledgements = this.acknowledgements.get(field)
            if (value === signature(this.incoming[field])) {
                // Even an unchanged prop can be a real external revert before
                // the first acknowledgement. A bounded read resolves that case.
                if (
                    acknowledgements &&
                    !this.acknowledged.has(field) &&
                    !this.refreshError &&
                    value !== signature(this.confirmed[field]) &&
                    !this.pending.some((intent) => intent.field === field)
                )
                    ambiguous.push(field)
                continue
            }
            this.versions[field]++
            if (acknowledgements?.has(value)) {
                if (!this.pending.some((intent) => intent.field === field)) {
                    if (value === signature(this.confirmed[field])) this.acknowledged.add(field)
                    else if (this.acknowledged.has(field)) ambiguous.push(field)
                }
            } else {
                this.confirmed = { ...this.confirmed, [field]: incoming[field] }
                this.acknowledgements.delete(field)
                this.acknowledged.delete(field)
                changed = true
            }
        }
        this.incoming = incoming
        if (changed) this.publish()
        if (ambiguous.length > 0) void this.verifyIncoming(ambiguous)
    }

    private async verifyIncoming(fields: Field[]) {
        // A later explicit retry must supersede an earlier read as well as edits.
        for (const field of fields) this.versions[field]++
        const versions = { ...this.versions }
        const isCurrent = (field: Field) =>
            versions[field] === this.versions[field] && !this.pending.some((intent) => intent.field === field)
        try {
            const response = await FileServiceClient.refreshSubagents({} as EmptyRequest)
            const agent = [...response.globalSubagents, ...response.localSubagents].find((item) => item.path === this.path)
            if (!agent) throw new Error("Subagent is no longer present in the refreshed directory")
            const config = readConfig(agent)
            for (const field of fields.filter(isCurrent)) {
                // Use the authoritative read as the new refresh baseline. A
                // subsequent old prop is revalidated, never silently adopted.
                this.incoming = { ...this.incoming, [field]: config[field] }
                if (signature(config[field]) === signature(this.confirmed[field])) {
                    this.acknowledged.add(field)
                } else {
                    this.confirmed = { ...this.confirmed, [field]: config[field] }
                    this.acknowledgements.delete(field)
                    this.acknowledged.delete(field)
                }
            }
            if (fields.some(isCurrent)) {
                this.refreshError = undefined
                this.publish()
            }
        } catch (error) {
            if (fields.some(isCurrent)) {
                const reason = error instanceof Error ? error.message : String(error)
                this.refreshError = `Could not verify refreshed configuration: ${reason}. Latest local choices were kept.`
                this.publish()
            }
        }
        this.release()
    }

    edit = <K extends Field>(field: K, update: (current: SubagentConfig[K]) => SubagentConfig[K]) => {
        const intent: Intent = { field, apply: (config) => ({ ...config, [field]: update(config[field]) }) }
        if (signature(intent.apply(this.snapshot.config)[field]) === signature(this.snapshot.config[field])) return
        this.pending.push(intent)
        this.versions[field]++
        this.error = undefined
        this.refreshError = undefined
        this.publish()
        void this.drain()
    }

    private publish() {
        this.snapshot = {
            config: this.pending.reduce((config, intent) => intent.apply(config), this.confirmed),
            saving: this.pending.length > 0,
            saved: this.saved,
            error: this.error,
            refreshError: this.refreshError,
        }
        for (const listener of this.listeners) listener()
    }

    private release() {
        const awaitingRefresh = [...this.acknowledgements.keys()].some((field) => !this.acknowledged.has(field))
        if (this.listeners.size === 0 && this.pending.length === 0 && !awaitingRefresh && sessions.get(this.path) === this) {
            sessions.delete(this.path)
        }
    }

    private async drain() {
        if (this.draining) return
        this.draining = true
        while (this.pending.length > 0) {
            const intent = this.pending[0]
            // Rebase each intent on successfully saved values, not an optimistic
            // full-array snapshot which could accidentally re-save a failed edit.
            const next = intent.apply(this.confirmed)
            const value = next[intent.field]
            let failed = false
            try {
                if (signature(value) !== signature(this.confirmed[intent.field])) {
                    const acknowledgements = this.acknowledgements.get(intent.field) ?? new Set<string>()
                    acknowledgements.add(signature(this.incoming[intent.field]))
                    acknowledgements.add(signature(this.confirmed[intent.field]))
                    acknowledgements.add(signature(value))
                    this.acknowledgements.set(intent.field, acknowledgements)
                    this.acknowledged.delete(intent.field)
                    await FileServiceClient.updateSubagentConfig(requestFor(this.path, intent.field, next))
                    // Do not replace unrelated fields with an older RPC snapshot.
                    this.confirmed = { ...this.confirmed, [intent.field]: value }
                    this.saved = true
                }
            } catch (error) {
                failed = true
                const reason = error instanceof Error ? error.message : String(error)
                this.error = `Could not save ${intent.field}: ${reason}. Failed change was rolled back.`
            }
            this.pending.shift()
            this.versions[intent.field]++
            if (!this.pending.some((pending) => pending.field === intent.field)) {
                if (failed) {
                    this.acknowledgements.delete(intent.field)
                    this.acknowledged.delete(intent.field)
                } else if (signature(this.incoming[intent.field]) === signature(this.confirmed[intent.field])) {
                    this.acknowledged.add(intent.field)
                }
            }
            this.publish()
        }
        this.draining = false
        this.release()
    }
}

/** SubagentRow is keyed by path so a different agent never inherits this session. */
export default function useSubagentConfig(agent: SubagentInfo) {
    const [session] = useState(() => {
        const existing = sessions.get(agent.path)
        if (existing) return existing
        const created = new SaveSession(agent.path, agent)
        sessions.set(agent.path, created)
        return created
    })
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
    useEffect(() => session.reconcile(agent), [agent, session])
    return { ...snapshot, edit: session.edit, refresh: session.refresh }
}
