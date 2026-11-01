import type { StateManager } from "@core/storage/StateManager"
import type { SettingsSnapshot } from "@core/storage/settings/settings-types"
import { type AwayConfiguration, type AwayPreferencePatch } from "@shared/away"
import { ExperimentalFeatureFlag } from "@shared/services/feature-flags/feature-flags"
import { Logger } from "@shared/services/Logger"
import { type FeatureFlagsService, featureFlagsService } from "@/services/feature-flags"

const hosts = new WeakMap<StateManager, AwaySettings>()
type AwaySettingsAuthority = Pick<
    StateManager,
    "subscribeAwaySettings" | "readAwaySettingsSnapshot" | "mutateAwayPreferences" | "revokeAwayMode"
>

/** One host binding; it publishes committed configuration, never task mode or deadlines. */
export class AwaySettings {
    private readonly listeners = new Set<(configuration: AwayConfiguration) => void>()
    private readonly unsubscribe: readonly (() => void)[]
    private queue: Promise<void> = Promise.resolve()
    private closed = false
    private gate: boolean
    private pendingRevocation = false
    private storageAvailable = false
    private snapshot?: SettingsSnapshot
    private current: AwayConfiguration = Object.freeze({
        available: false,
        gateEnabled: false,
        awayModeEnabled: false,
        autoAwayModeEnabled: false,
        revocations: Object.freeze({ mode: 0, automatic: 0 }),
    })

    constructor(
        private readonly stateManager: AwaySettingsAuthority,
        private readonly flags: FeatureFlagsService,
    ) {
        this.gate = flags.getBooleanFlagEnabled(ExperimentalFeatureFlag.AWAY_MODE)
        this.unsubscribe = [
            stateManager.subscribeAwaySettings(
                (snapshot) => this.adopt(snapshot),
                () => this.unavailable(),
            ),
            flags.onDidChange(() => this.gateChanged()),
        ]
        try {
            this.adopt(stateManager.readAwaySettingsSnapshot())
        } catch {
            this.unavailable()
        }
        if (!this.gate) {
            this.pendingRevocation = true
            this.publish()
            this.scheduleRevocation()
        }
    }

    read(): AwayConfiguration {
        return this.current
    }

    subscribe(listener: (configuration: AwayConfiguration) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async mutate(patch: AwayPreferencePatch): Promise<void> {
        if (this.closed) throw new Error("Away settings binding is closed")
        // Each call reaches the repository queue immediately, without coalescing close/open.
        try {
            await this.stateManager.mutateAwayPreferences(patch)
            await this.reconcile()
        } catch (error) {
            this.pendingRevocation = true
            this.unavailable()
            throw error
        }
    }

    /** Re-read the authority before a writer releases restored commands. */
    async reconcile(): Promise<AwayConfiguration> {
        await this.queue
        if (this.closed) return this.current
        if (this.pendingRevocation) await this.persistRevocation()
        this.adopt(this.stateManager.readAwaySettingsSnapshot())
        return this.current
    }

    beginClose(): void {
        if (this.closed) return
        this.closed = true
        for (const unsubscribe of this.unsubscribe) unsubscribe()
        this.unavailable()
        this.listeners.clear()
    }

    async dispose(): Promise<void> {
        this.beginClose()
        await this.queue
    }

    private adopt(snapshot: SettingsSnapshot): void {
        if (this.closed) return
        this.snapshot = snapshot
        this.storageAvailable = true
        this.publish()
    }

    private unavailable(): void {
        if (this.storageAvailable) this.pendingRevocation = true
        this.storageAvailable = false
        this.publish()
    }

    private publish(): void {
        const snapshot = this.snapshot
        this.current = Object.freeze({
            available: !this.closed && this.storageAvailable && !this.pendingRevocation,
            gateEnabled: this.gate,
            awayModeEnabled: snapshot?.values.awayModeEnabled === true,
            autoAwayModeEnabled: snapshot?.values.autoAwayModeEnabled === true,
            revocations: snapshot?.awayRevocations ?? this.current.revocations,
        })
        for (const listener of this.listeners) {
            try {
                listener(this.current)
            } catch (error) {
                Logger.error("[AwaySettings] Configuration listener failed:", error)
            }
        }
    }

    private gateChanged(): void {
        if (this.closed) return
        const next = this.flags.getBooleanFlagEnabled(ExperimentalFeatureFlag.AWAY_MODE)
        if (this.gate && !next) this.pendingRevocation = true
        this.gate = next
        this.publish() // Revoke permission synchronously, before persistence or UI work.
        if (this.pendingRevocation) this.scheduleRevocation()
    }

    private scheduleRevocation(): void {
        this.queue = this.queue
            .then(() => this.persistRevocation())
            .catch((error) => {
                this.unavailable()
                Logger.error("[AwaySettings] Failed to persist gate revocation:", error)
            })
    }

    private async persistRevocation(): Promise<void> {
        if (this.closed || !this.pendingRevocation) return
        await this.stateManager.revokeAwayMode()
        this.pendingRevocation = false
        this.adopt(this.stateManager.readAwaySettingsSnapshot())
    }
}

/** Explicit host startup and task composition share the same binding, including early recovery. */
export function getAwaySettings(stateManager: StateManager, flags = featureFlagsService): AwaySettings {
    let host = hosts.get(stateManager)
    if (!host) {
        host = new AwaySettings(stateManager, flags)
        hosts.set(stateManager, host)
    }
    return host
}
