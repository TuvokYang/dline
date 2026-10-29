import { scanRuleToggles } from "@core/context/instructions/user-instructions/rule-helpers"
import { getWorkflowsScanDirectories } from "@core/storage/disk"
import { resolveCapabilityToggles } from "@core/storage/settings/capability-toggle-store"
import { ClineRulesToggles } from "@shared/cline-rules"
import { Logger } from "@shared/services/Logger"
import { Controller } from "@/core/controller"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

/**
 * Refresh the workflow toggles.
 * Scans multiple directories:
 *   - Project: .agents/workflows/ (new) + .clinerules/workflows/ (legacy compat)
 *   - Global:  ~/Documents/dline/workflows/
 *
 * Discovery is read-only: it reports what exists on disk and resolves the
 * effective state against stored preferences in memory. Persisting a preference
 * is reserved for explicit user toggles, so this stays off the storage write
 * path and never contends for the cross-process settings lock.
 */
export async function refreshWorkflowToggles(
    controller: Controller,
    workingDirectory: string,
): Promise<{
    globalWorkflowToggles: ClineRulesToggles
    localWorkflowToggles: ClineRulesToggles
    discoveredLocalToggles: ClineRulesToggles
    localScanComplete: boolean
}> {
    const startedAt = performance.now()
    const scanDirs = getWorkflowsScanDirectories(workingDirectory)

    const discoveredGlobal: ClineRulesToggles = {}
    const discoveredLocal: ClineRulesToggles = {}
    // One unreadable local root makes the whole local result untrustworthy: the
    // caller cannot tell which workflows that root would have contributed.
    let localScanComplete = true

    // Scan each directory independently, then merge the discovered paths. Passing
    // an empty map avoids one directory deleting entries discovered from a
    // sibling directory.
    for (const dir of scanDirs) {
        const scan = await scanRuleToggles(dir.path, {})
        if (dir.source === "global") {
            Object.assign(discoveredGlobal, scan.toggles)
        } else {
            Object.assign(discoveredLocal, scan.toggles)
            if (!scan.complete) localScanComplete = false
        }
    }

    // Global entries resolve through the same scope chain as project entries, so a
    // workspace or task override applies to both.
    const globalToggles = resolveCapabilityToggles(controller.stateManager, "workflows", discoveredGlobal)
    const localToggles = resolveCapabilityToggles(controller.stateManager, "workflows", discoveredLocal)
    recordPerfPhase(
        PerfDomain.Capability,
        "workflows_refresh",
        performance.now() - startedAt,
        {
            directories: scanDirs.length,
            global: Object.keys(globalToggles).length,
            local: Object.keys(localToggles).length,
            localComplete: localScanComplete,
        },
        { taskId: controller.task?.taskId },
    )
    if (Logger.isDebugEnabled()) {
        Logger.debug(
            `[CapabilityPerf] phase=workflows_refresh taskId=${controller.task?.taskId ?? "none"} durationMs=${Math.round(performance.now() - startedAt)} directories=${scanDirs.length} global=${Object.keys(globalToggles).length} local=${Object.keys(localToggles).length} localComplete=${localScanComplete}`,
        )
    }

    return {
        globalWorkflowToggles: globalToggles,
        localWorkflowToggles: localToggles,
        // The raw scan says which workflows exist; the resolved map above already
        // folds in the user's overrides and cannot answer that question.
        discoveredLocalToggles: discoveredLocal,
        localScanComplete,
    }
}
