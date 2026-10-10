import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { Logger } from "@shared/services/Logger"
import chokidar, { type FSWatcher } from "chokidar"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { FileLock } from "../storage/backend/jsonl/FileLock"

export interface ProfileCatalogCommit {
    previous: ApiProfile[]
    profiles: ApiProfile[]
}

export interface ProfileCatalogRepositoryOptions {
    filePath: string
    read: () => Promise<ApiProfile[]>
    write: (profiles: ApiProfile[]) => Promise<void>
    watch?: boolean
}

type ProfileCatalogListener = (commit: ProfileCatalogCommit) => void | Promise<void>

function cloneProfiles(profiles: readonly ApiProfile[]): ApiProfile[] {
    return profiles.map((profile) => structuredClone(profile))
}

function profileHash(profiles: readonly ApiProfile[]): string {
    return createHash("sha256").update(JSON.stringify(profiles)).digest("hex")
}

function mergeLegacyNames(
    currentName: string,
    baseline: ApiProfile | undefined,
    requested: ApiProfile,
    latest: ApiProfile | undefined,
): string[] {
    const candidates = [
        ...(latest?.legacyNames ?? []),
        ...(baseline?.legacyNames ?? []),
        ...(requested.legacyNames ?? []),
        ...(baseline && baseline.name !== requested.name ? [baseline.name] : []),
        ...(latest && latest.name !== requested.name ? [latest.name] : []),
    ]
    return [...new Set(candidates.filter((name) => name && name !== currentName))]
}

function hasRequestedOrderChange(baseline: readonly ApiProfile[], requested: readonly ApiProfile[]): boolean {
    const baselineIds = new Set(baseline.map(({ id }) => id))
    const requestedIds = requested.map(({ id }) => id)
    const requestedIdSet = new Set(requestedIds)
    const unchangedOrder = [
        ...baseline.filter(({ id }) => requestedIdSet.has(id)).map(({ id }) => id),
        ...requestedIds.filter((id) => !baselineIds.has(id)),
    ]
    return requestedIds.some((id, index) => id !== unchangedOrder[index])
}

function applyRequestedOrder(merged: ApiProfile[], requested: readonly ApiProfile[]): ApiProfile[] {
    const mergedById = new Map(merged.map((profile) => [profile.id, profile]))
    const requestedIds = requested.map(({ id }) => id).filter((id) => mergedById.has(id))
    const requestedIdSet = new Set(requestedIds)
    let requestedIndex = 0

    return merged.map((profile) => {
        if (!requestedIdSet.has(profile.id)) return profile
        const requestedId = requestedIds[requestedIndex++]
        return (requestedId && mergedById.get(requestedId)) || profile
    })
}

/** Apply one client's stable-ID diff to the latest disk Catalog. */
export function mergeProfileCatalog(
    baseline: readonly ApiProfile[],
    requested: readonly ApiProfile[],
    latest: readonly ApiProfile[],
): ApiProfile[] {
    const baselineById = new Map(baseline.map((profile) => [profile.id, profile]))
    const requestedById = new Map(requested.map((profile) => [profile.id, profile]))
    const removedIds = new Set([...baselineById.keys()].filter((id) => !requestedById.has(id)))
    const latestById = new Map(latest.map((profile) => [profile.id, profile]))
    const changedById = new Map<string, ApiProfile>()
    for (const [id, profile] of requestedById) {
        const baselineProfile = baselineById.get(id)
        if (JSON.stringify(baselineProfile) !== JSON.stringify(profile)) {
            changedById.set(id, {
                ...profile,
                legacyNames: mergeLegacyNames(profile.name, baselineProfile, profile, latestById.get(id)),
            })
        }
    }

    const merged: ApiProfile[] = []
    const appliedIds = new Set<string>()
    for (const profile of latest) {
        if (removedIds.has(profile.id)) continue
        const changed = changedById.get(profile.id)
        merged.push(structuredClone(changed ?? profile))
        appliedIds.add(profile.id)
    }
    for (const [id, profile] of changedById) {
        if (!appliedIds.has(id)) merged.push(structuredClone(profile))
    }
    return hasRequestedOrderChange(baseline, requested) ? applyRequestedOrder(merged, requested) : merged
}

/** Cross-process transactional repository for the Profile Catalog array. */
export class ProfileCatalogRepository {
    private readonly fileLock = new FileLock()
    private readonly listeners = new Set<ProfileCatalogListener>()
    private readonly watchEnabled: boolean
    private operationQueue: Promise<void> = Promise.resolve()
    private snapshot: ApiProfile[] = []
    private snapshotHash = profileHash([])
    private initialized = false
    private watcher?: FSWatcher

    constructor(private readonly options: ProfileCatalogRepositoryOptions) {
        this.watchEnabled = options.watch ?? true
    }

    async initialize(): Promise<ApiProfile[]> {
        if (this.initialized) return cloneProfiles(this.snapshot)
        const startedAt = performance.now()
        this.snapshot = await this.options.read()
        this.snapshotHash = profileHash(this.snapshot)
        this.initialized = true
        if (this.watchEnabled) await this.startWatcher()
        recordPerfPhase(PerfDomain.Profile, "catalog_initialize", performance.now() - startedAt, {
            profiles: this.snapshot.length,
            watch: this.watchEnabled,
        })
        if (Logger.isDebugEnabled()) {
            Logger.debug(
                `[ProfilePerf] phase=catalog_initialize durationMs=${Math.round(performance.now() - startedAt)} profiles=${this.snapshot.length} watch=${this.watchEnabled}`,
            )
        }
        return cloneProfiles(this.snapshot)
    }

    async mutate(baseline: readonly ApiProfile[], requested: readonly ApiProfile[]): Promise<ProfileCatalogCommit> {
        const requestedAt = performance.now()
        return this.enqueue(async () => {
            const queueMs = Math.round(performance.now() - requestedAt)
            await this.initialize()
            await fs.mkdir(path.dirname(this.options.filePath), { recursive: true })
            let commit: ProfileCatalogCommit | undefined
            const lockRequestedAt = performance.now()
            let lockAcquiredAt = lockRequestedAt
            await this.fileLock.withLock(this.options.filePath, async () => {
                lockAcquiredAt = performance.now()
                const latest = await this.options.read()
                const profiles = mergeProfileCatalog(baseline, requested, latest)
                await this.options.write(profiles)
                this.snapshot = cloneProfiles(profiles)
                this.snapshotHash = profileHash(this.snapshot)
                commit = { previous: cloneProfiles(latest), profiles: cloneProfiles(profiles) }
            })
            if (!commit) throw new Error("Profile Catalog transaction completed without a commit")
            recordPerfPhase(PerfDomain.Profile, "catalog_mutate", performance.now() - requestedAt, {
                queueMs,
                lockWaitMs: Math.round(lockAcquiredAt - lockRequestedAt),
                transactionMs: Math.round(performance.now() - lockAcquiredAt),
                baseline: baseline.length,
                requested: requested.length,
                committed: commit.profiles.length,
            })
            if (Logger.isDebugEnabled()) {
                Logger.debug(
                    `[ProfilePerf] phase=catalog_mutate queueMs=${queueMs} lockWaitMs=${Math.round(lockAcquiredAt - lockRequestedAt)} transactionMs=${Math.round(performance.now() - lockAcquiredAt)} totalMs=${Math.round(performance.now() - requestedAt)} baseline=${baseline.length} requested=${requested.length} committed=${commit.profiles.length}`,
                )
            }
            return commit
        })
    }

    subscribe(listener: ProfileCatalogListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async flush(): Promise<void> {
        await this.operationQueue
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation)
        this.operationQueue = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }

    private async startWatcher(): Promise<void> {
        const watcher = chokidar.watch(this.options.filePath, {
            persistent: false,
            ignoreInitial: true,
            atomic: true,
            awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        })
        this.watcher = watcher
        const reconcile = () => {
            void this.enqueue(() => this.reconcileFromDisk()).catch((error) => {
                Logger.error("[ProfileCatalogRepository] Failed to reconcile external commit:", error)
            })
        }
        watcher.on("add", reconcile).on("change", reconcile).on("unlink", reconcile)
        await new Promise<void>((resolve) => {
            watcher.once("ready", resolve)
            watcher.once("error", () => resolve())
        })
        // Close the read-before-watch gap: a commit may land while chokidar starts.
        await this.reconcileFromDisk()
    }

    private async reconcileFromDisk(): Promise<void> {
        const startedAt = performance.now()
        const profiles = await this.options.read()
        const nextHash = profileHash(profiles)
        if (nextHash === this.snapshotHash) return
        const previous = cloneProfiles(this.snapshot)
        this.snapshot = cloneProfiles(profiles)
        this.snapshotHash = nextHash
        for (const listener of this.listeners) await listener({ previous, profiles: cloneProfiles(profiles) })
        recordPerfPhase(PerfDomain.Profile, "catalog_reconcile", performance.now() - startedAt, {
            profiles: profiles.length,
            listeners: this.listeners.size,
        })
        if (Logger.isDebugEnabled()) {
            Logger.debug(
                `[ProfilePerf] phase=catalog_reconcile durationMs=${Math.round(performance.now() - startedAt)} profiles=${profiles.length} listeners=${this.listeners.size}`,
            )
        }
    }
}
