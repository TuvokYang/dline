/** Clock and timers, injected so the state machine runs without real time in tests. */
export interface LivenessTimers {
    now(): number
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

export type LivenessReportKind = "boot_timeout" | "unresponsive" | "reloaded" | "recovery_exhausted"

/** A content-free observation for logs and telemetry. */
export interface LivenessReport {
    readonly kind: LivenessReportKind
    /** Reloads spent in the current failure episode. */
    readonly attempt: number
    /** Time since the episode's document was assigned or last confirmed alive. */
    readonly elapsedMs: number
    readonly visible: boolean
}

/** What the monitor asks of the webview host it watches. */
export interface WebviewLivenessPort {
    /** Assign the webview document again so it boots from scratch. */
    reassignHtml(): Promise<void>
    sendPing(nonce: string): void
    isVisible(): boolean
    /**
     * Whether the window has focus. An unfocused window may throttle its webviews,
     * so timeouts there are deferred rather than judged. Treated as focused when absent.
     */
    isFocused?(): boolean
    report(report: LivenessReport): void
    /** Automatic recovery gave up; offer the user a manual way out. */
    notifyExhausted(): void
    /** The monitor was disposed with its view. */
    released?(): void
}

export interface WebviewLivenessOptions {
    readonly bootTimeoutMs?: number
    readonly probeTimeoutMs?: number
    /** A view shown again after this much silence is probed before it is trusted. */
    readonly staleAfterMs?: number
    readonly maxReloads?: number
    readonly reloadBackoffMs?: number
    /** Consecutive unanswered pings before a document counts as unresponsive. */
    readonly probeMissesBeforeReload?: number
}

const DEFAULTS: Required<WebviewLivenessOptions> = {
    bootTimeoutMs: 15_000,
    // Generous: a view busy with its first render after being shown answers late, not never.
    probeTimeoutMs: 10_000,
    staleAfterMs: 10_000,
    maxReloads: 2,
    reloadBackoffMs: 1_000,
    probeMissesBeforeReload: 2,
}

/**
 * - `booting`: a document was assigned and its root component has not mounted yet.
 * - `confirming`: a reloaded document announced itself; a ping proves the
 *   announcement came from it rather than from the document it replaced.
 * - `probing`: a view shown after a silence must answer a ping.
 * - `reloading`: waiting out the backoff before assigning the document again.
 */
type LivenessPhase = "idle" | "booting" | "confirming" | "ready" | "probing" | "reloading" | "exhausted" | "disposed"

/**
 * Detects a webview whose document never booted or stopped answering, reloads
 * it a bounded number of times, and hands over to the user when that fails.
 *
 * Timers only run while the view is visible: VS Code may defer or throttle a
 * hidden webview, and silence there says nothing about its health.
 */
export class WebviewLivenessMonitor {
    private readonly options: Required<WebviewLivenessOptions>
    private phase: LivenessPhase = "idle"
    private attempt = 0
    private timer: unknown
    private timerArmed = false
    private pingSequence = 0
    private pendingNonce: string | undefined
    private pingSentAt = 0
    private missedProbes = 0
    private lastHeardAt: number
    private episodeStartedAt: number

    constructor(
        private readonly port: WebviewLivenessPort,
        private readonly timers: LivenessTimers,
        options: WebviewLivenessOptions = {},
    ) {
        this.options = { ...DEFAULTS, ...options }
        this.lastHeardAt = timers.now()
        this.episodeStartedAt = this.lastHeardAt
    }

    get state(): LivenessPhase {
        return this.phase
    }

    /**
     * The host assigned the initial document. A document that already announced
     * itself while the assignment was in flight stays ready.
     */
    htmlAssigned(): void {
        if (this.phase !== "idle") return
        this.enterBooting()
    }

    /**
     * The document's script is running. That alone does not prove it booted: a
     * script whose render fails still shows a blank view, so only
     * `webviewMounted` ends booting.
     */
    webviewReady(): void {
        this.heard()
    }

    /** The document's root component mounted. */
    webviewMounted(): void {
        if (this.phase === "disposed") return
        this.heard()
        if (this.phase === "booting" && this.attempt > 0) {
            this.phase = "confirming"
            this.sendPing()
            return
        }
        // Without a new document assigned, the announcing document is the current
        // one, so it is alive even if a probe or a pending reload doubted it.
        if (this.phase !== "ready" && this.phase !== "confirming") this.becomeReady()
    }

    /** Any message from the document shows it was alive when it was sent. */
    heard(): void {
        if (this.phase === "disposed") return
        this.lastHeardAt = this.timers.now()
    }

    pong(nonce: unknown): void {
        if (this.phase === "disposed") return
        this.heard()
        if (typeof nonce !== "string" || nonce !== this.pendingNonce) return
        if (this.phase === "confirming") this.report("reloaded")
        this.becomeReady()
    }

    visibilityChanged(visible: boolean): void {
        if (this.phase === "disposed") return
        if (!visible) {
            // A hidden view may be throttled; pause instead of judging it.
            if (this.phase === "booting" || this.phase === "confirming" || this.phase === "probing") this.clearTimer()
            if (this.phase === "probing") {
                this.pendingNonce = undefined
                this.missedProbes = 0
                this.phase = "ready"
            }
            return
        }
        switch (this.phase) {
            case "booting":
                if (!this.timerArmed) this.armTimer(this.options.bootTimeoutMs, () => this.onBootTimeout())
                return
            case "confirming":
                if (!this.timerArmed) this.sendPing()
                return
            case "ready":
                if (this.timers.now() - this.lastHeardAt >= this.options.staleAfterMs) {
                    this.phase = "probing"
                    this.missedProbes = 0
                    this.episodeStartedAt = this.timers.now()
                    this.sendPing()
                }
                return
            default:
                return
        }
    }

    /** Reload on request, starting a fresh episode whatever the current state. */
    async reload(): Promise<void> {
        if (this.phase === "disposed") return
        this.clearTimer()
        // Counted as the first reload so the new document must prove itself with a ping.
        this.attempt = 1
        await this.assignAgain()
    }

    dispose(): void {
        if (this.phase === "disposed") return
        this.clearTimer()
        this.pendingNonce = undefined
        this.phase = "disposed"
        this.port.released?.()
    }

    private enterBooting(): void {
        this.clearTimer()
        this.pendingNonce = undefined
        this.missedProbes = 0
        this.phase = "booting"
        this.episodeStartedAt = this.timers.now()
        if (this.port.isVisible()) this.armTimer(this.options.bootTimeoutMs, () => this.onBootTimeout())
    }

    private becomeReady(): void {
        this.clearTimer()
        this.pendingNonce = undefined
        this.missedProbes = 0
        this.attempt = 0
        this.phase = "ready"
    }

    private sendPing(): void {
        this.pingSequence += 1
        const nonce = `${this.pingSequence}`
        this.pendingNonce = nonce
        this.pingSentAt = this.timers.now()
        this.port.sendPing(nonce)
        if (this.port.isVisible()) this.armTimer(this.options.probeTimeoutMs, () => this.onProbeTimeout())
    }

    private onBootTimeout(): void {
        if (this.phase !== "booting") return
        if (this.deferWhileUnfocused(this.options.bootTimeoutMs, () => this.onBootTimeout())) return
        this.report("boot_timeout")
        this.recover()
    }

    private onProbeTimeout(): void {
        if (this.phase !== "probing" && this.phase !== "confirming") return
        if (this.deferWhileUnfocused(this.options.probeTimeoutMs, () => this.onProbeTimeout())) return
        // A probed view that kept talking is alive even if its answer is late. A reloaded
        // document being confirmed must answer the ping itself, so it gets no such credit.
        if (this.phase === "probing" && this.lastHeardAt > this.pingSentAt) {
            this.becomeReady()
            return
        }
        this.missedProbes += 1
        if (this.missedProbes < this.options.probeMissesBeforeReload) {
            this.sendPing()
            return
        }
        this.pendingNonce = undefined
        this.report("unresponsive")
        this.recover()
    }

    /** Re-arm a check instead of judging while the window is unfocused. */
    private deferWhileUnfocused(ms: number, check: () => void): boolean {
        if (this.port.isFocused?.() !== false) return false
        this.armTimer(ms, check)
        return true
    }

    private recover(): void {
        if (this.attempt >= this.options.maxReloads) {
            this.phase = "exhausted"
            this.report("recovery_exhausted")
            this.port.notifyExhausted()
            return
        }
        this.attempt += 1
        this.phase = "reloading"
        const backoff = this.options.reloadBackoffMs * 2 ** (this.attempt - 1)
        this.armTimer(backoff, () => void this.assignAgain())
    }

    private async assignAgain(): Promise<void> {
        this.enterBooting()
        try {
            await this.port.reassignHtml()
        } catch {
            // A rejected assignment is one more failed boot; the timer decides.
        }
    }

    private report(kind: LivenessReportKind): void {
        this.port.report({
            kind,
            attempt: this.attempt,
            elapsedMs: Math.max(0, this.timers.now() - this.episodeStartedAt),
            visible: this.port.isVisible(),
        })
    }

    private armTimer(ms: number, callback: () => void): void {
        this.clearTimer()
        this.timerArmed = true
        this.timer = this.timers.setTimeout(() => {
            this.timerArmed = false
            this.timer = undefined
            if (this.phase === "disposed") return
            callback()
        }, ms)
    }

    private clearTimer(): void {
        if (this.timerArmed) this.timers.clearTimeout(this.timer)
        this.timerArmed = false
        this.timer = undefined
    }
}
