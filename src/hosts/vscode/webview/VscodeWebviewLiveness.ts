import * as vscode from "vscode"
import { telemetryService } from "@/services/telemetry"
import type { TelemetrySeverity } from "@/services/telemetry/providers/capabilities"
import { Logger } from "@/shared/services/Logger"
import { type LivenessReport, type LivenessTimers, WebviewLivenessMonitor } from "./WebviewLivenessMonitor"

/** Transport control messages beside `webviewReady`; they carry no business payload. */
export const WEBVIEW_PING_MESSAGE = "dlinePing"
export const WEBVIEW_PONG_MESSAGE = "dlinePong"

export type WebviewSurface = "panel" | "sidebar"

export interface VscodeWebviewLivenessOptions {
    readonly surface: WebviewSurface
    readonly webview: () => vscode.Webview | undefined
    readonly isVisible: () => boolean
    /** Assign the document again; the caller resets its own readiness first. */
    readonly assignHtml: () => Promise<void>
}

const SEVERITY: Record<LivenessReport["kind"], TelemetrySeverity> = {
    boot_timeout: "warn",
    unresponsive: "warn",
    reloaded: "info",
    recovery_exhausted: "error",
}

const systemTimers: LivenessTimers = {
    now: () => Date.now(),
    // Unreferenced: a pending liveness check must never keep the process alive.
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** Monitors of the Dline webviews that are currently open, for the manual reload command. */
const openMonitors = new Map<WebviewLivenessMonitor, () => boolean>()

/** Wire a liveness monitor to one VS Code webview surface. */
export function createVscodeWebviewLiveness(options: VscodeWebviewLivenessOptions): WebviewLivenessMonitor {
    const monitor: WebviewLivenessMonitor = new WebviewLivenessMonitor(
        {
            reassignHtml: options.assignHtml,
            sendPing: (nonce) => {
                void Promise.resolve(options.webview()?.postMessage({ type: WEBVIEW_PING_MESSAGE, nonce })).catch(() => {
                    // An undelivered ping is answered by the probe timeout.
                })
            },
            isVisible: options.isVisible,
            isFocused: () => vscode.window.state?.focused !== false,
            report: (report) => reportLiveness(options.surface, report),
            notifyExhausted: () => void offerManualRecovery(monitor),
            released: () => void openMonitors.delete(monitor),
        },
        systemTimers,
    )
    openMonitors.set(monitor, options.isVisible)
    return monitor
}

/** Reload every visible Dline webview; used by the `dline.reloadWebview` command. */
export async function reloadVisibleWebviews(): Promise<number> {
    const visible = [...openMonitors].filter(([, isVisible]) => isVisible()).map(([monitor]) => monitor)
    await Promise.all(visible.map((monitor) => monitor.reload()))
    return visible.length
}

function reportLiveness(surface: WebviewSurface, report: LivenessReport): void {
    const summary = `[WebviewLiveness] ${surface} ${report.kind}: attempt=${report.attempt} elapsedMs=${report.elapsedMs} visible=${report.visible}`
    if (report.kind === "reloaded") Logger.info(summary)
    else Logger.warn(summary)
    try {
        telemetryService.captureRuntimeEvent(
            `webview.${report.kind}`,
            { surface, attempt: report.attempt, elapsed_ms: report.elapsedMs, visible: report.visible },
            SEVERITY[report.kind],
        )
    } catch {
        // Telemetry must not change how the view recovers.
    }
}

async function offerManualRecovery(monitor: WebviewLivenessMonitor): Promise<void> {
    const reloadView = "Reload Dline View"
    const reloadWindow = "Reload Window"
    const choice = await vscode.window.showWarningMessage(
        "A Dline view stopped responding and could not be recovered automatically.",
        reloadView,
        reloadWindow,
    )
    if (choice === reloadView) await monitor.reload()
    else if (choice === reloadWindow) await vscode.commands.executeCommand("workbench.action.reloadWindow")
}
