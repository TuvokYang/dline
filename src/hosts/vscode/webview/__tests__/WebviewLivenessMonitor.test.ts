import { describe, expect, it } from "vitest"
import { type LivenessReport, type LivenessTimers, WebviewLivenessMonitor } from "../WebviewLivenessMonitor"

class FakeTimers implements LivenessTimers {
    private time = 0
    private nextId = 0
    private readonly pending = new Map<number, { at: number; callback: () => void }>()

    now(): number {
        return this.time
    }

    setTimeout(callback: () => void, ms: number): unknown {
        const id = ++this.nextId
        this.pending.set(id, { at: this.time + ms, callback })
        return id
    }

    clearTimeout(handle: unknown): void {
        this.pending.delete(handle as number)
    }

    get armed(): number {
        return this.pending.size
    }

    advance(ms: number): void {
        const target = this.time + ms
        for (;;) {
            const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
            if (!due) break
            this.pending.delete(due[0])
            this.time = due[1].at
            due[1].callback()
        }
        this.time = target
    }
}

function createMonitor(visible = true) {
    const timers = new FakeTimers()
    const state = {
        visible,
        focused: true,
        reassigned: 0,
        pings: [] as string[],
        reports: [] as LivenessReport[],
        exhausted: 0,
    }
    const monitor = new WebviewLivenessMonitor(
        {
            reassignHtml: async () => {
                state.reassigned++
            },
            sendPing: (nonce) => void state.pings.push(nonce),
            isVisible: () => state.visible,
            isFocused: () => state.focused,
            report: (report) => void state.reports.push(report),
            notifyExhausted: () => {
                state.exhausted++
            },
        },
        timers,
        { bootTimeoutMs: 15_000, probeTimeoutMs: 3_000, staleAfterMs: 10_000, maxReloads: 2, reloadBackoffMs: 1_000 },
    )
    return { monitor, timers, state }
}

const lastPing = (state: { pings: string[] }) => state.pings[state.pings.length - 1]

describe("WebviewLivenessMonitor", () => {
    it("never reloads a document that announces itself in time", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        timers.advance(5_000)
        monitor.webviewMounted()
        timers.advance(60_000)

        expect(monitor.state).toBe("ready")
        expect(state.reassigned).toBe(0)
        expect(state.reports).toEqual([])
    })

    it("reloads a document that never boots and confirms the new one with a ping", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        timers.advance(15_000)
        expect(state.reports.map((report) => report.kind)).toEqual(["boot_timeout"])
        expect(monitor.state).toBe("reloading")

        timers.advance(1_000)
        expect(state.reassigned).toBe(1)
        monitor.webviewMounted()
        expect(monitor.state).toBe("confirming")
        monitor.pong(lastPing(state))

        expect(monitor.state).toBe("ready")
        expect(state.reports.map((report) => report.kind)).toEqual(["boot_timeout", "reloaded"])
    })

    it("does not trust a late announcement from the replaced document", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        timers.advance(16_000)
        expect(state.reassigned).toBe(1)

        // The replaced document's announcement arrives, but nothing answers either ping.
        monitor.webviewMounted()
        monitor.pong("stale-nonce")
        monitor.heard()
        timers.advance(6_000)

        expect(state.reports.map((report) => report.kind)).toEqual(["boot_timeout", "unresponsive"])
        expect(monitor.state).toBe("reloading")
    })

    it("gives up after the reload limit and asks the user", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        timers.advance(15_000 + 1_000 + 15_000 + 2_000 + 15_000)

        expect(state.reassigned).toBe(2)
        expect(monitor.state).toBe("exhausted")
        expect(state.exhausted).toBe(1)
        expect(state.reports.map((report) => report.kind)).toEqual([
            "boot_timeout",
            "boot_timeout",
            "boot_timeout",
            "recovery_exhausted",
        ])
        timers.advance(120_000)
        expect(state.reassigned).toBe(2)
    })

    it("does not judge a hidden view, and starts the boot timer once it is shown", () => {
        const { monitor, timers, state } = createMonitor(false)
        monitor.htmlAssigned()
        timers.advance(120_000)
        expect(state.reports).toEqual([])

        state.visible = true
        monitor.visibilityChanged(true)
        timers.advance(15_000)
        expect(state.reports.map((report) => report.kind)).toEqual(["boot_timeout"])
    })

    it("probes a view shown after a silence and reloads it when the probe goes unanswered", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        monitor.webviewMounted()
        timers.advance(30_000)

        monitor.visibilityChanged(true)
        expect(monitor.state).toBe("probing")
        timers.advance(3_000)
        // One missed answer only repeats the ping.
        expect(state.reports).toEqual([])
        expect(state.pings).toHaveLength(2)
        timers.advance(3_000)

        expect(state.reports.map((report) => report.kind)).toEqual(["unresponsive"])
        timers.advance(1_000)
        expect(state.reassigned).toBe(1)
    })

    it("keeps a probed view that is still talking even when its answer is late", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        monitor.webviewMounted()
        timers.advance(30_000)
        monitor.visibilityChanged(true)
        timers.advance(1_000)
        monitor.heard()
        timers.advance(2_000)

        expect(monitor.state).toBe("ready")
        expect(state.reports).toEqual([])
    })

    it("treats a script that runs but never mounts its root as a failed boot", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        monitor.webviewReady()
        timers.advance(15_000)

        expect(state.reports.map((report) => report.kind)).toEqual(["boot_timeout"])
    })

    it("defers every judgement while the window is unfocused", () => {
        const { monitor, timers, state } = createMonitor()
        state.focused = false
        monitor.htmlAssigned()
        timers.advance(300_000)
        expect(state.reports).toEqual([])
        expect(monitor.state).toBe("booting")

        state.focused = true
        timers.advance(15_000)
        expect(state.reports.map((report) => report.kind)).toEqual(["boot_timeout"])
    })

    it("accepts a timely pong and skips the probe after recent traffic", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        monitor.webviewMounted()
        timers.advance(30_000)
        monitor.visibilityChanged(true)
        monitor.pong(lastPing(state))
        expect(monitor.state).toBe("ready")

        timers.advance(5_000)
        monitor.heard()
        monitor.visibilityChanged(true)
        expect(monitor.state).toBe("ready")
        expect(state.pings).toHaveLength(1)
    })

    it("cancels a probe when the view is hidden again", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        monitor.webviewMounted()
        timers.advance(30_000)
        monitor.visibilityChanged(true)
        state.visible = false
        monitor.visibilityChanged(false)
        timers.advance(60_000)

        expect(monitor.state).toBe("ready")
        expect(state.reports).toEqual([])
    })

    it("leaves no timer behind after dispose", () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        monitor.dispose()
        timers.advance(120_000)

        expect(timers.armed).toBe(0)
        expect(state.reports).toEqual([])
        expect(state.reassigned).toBe(0)
    })

    it("reloads on request from the exhausted state and recovers", async () => {
        const { monitor, timers, state } = createMonitor()
        monitor.htmlAssigned()
        timers.advance(60_000)
        expect(monitor.state).toBe("exhausted")

        await monitor.reload()
        monitor.webviewMounted()
        monitor.pong(lastPing(state))

        expect(monitor.state).toBe("ready")
        expect(state.reports.at(-1)?.kind).toBe("reloaded")
    })
})
