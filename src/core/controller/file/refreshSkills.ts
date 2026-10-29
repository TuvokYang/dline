import { parseRemoteSkillEntries } from "@core/context/instructions/user-instructions/skills"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import {
    type CapabilityScanResult,
    completeScan,
    incompleteScan,
    mergeScans,
} from "@core/storage/settings/capability-scan-result"
import { pruneCapabilityOrphans, resolveCapabilityToggles } from "@core/storage/settings/capability-toggle-store"
import { RefreshedSkills, SkillInfo } from "@shared/proto/dline/file"
import fs from "fs/promises"
import path from "path"
import { parseYamlFrontmatter } from "@/core/context/instructions/user-instructions/frontmatter"
import { getSkillsDirectoriesForScan } from "@/core/storage/disk"
import { HostProvider } from "@/hosts/host-provider"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath, isDirectory } from "@/utils/fs"
import { Controller } from ".."
import { rememberDiscoveredToggles } from "./capability-discovery-cache"
import { coalesceCapabilityScan } from "./refresh-coalescing"

/**
 * Scan a directory for skill subdirectories containing SKILL.md files.
 *
 * Reports whether the directory could be read. A missing directory is a
 * complete answer ("no skills here"), but an unreadable one is not: treating
 * the two alike would let a transient failure look like a deletion.
 */
async function scanSkillsDirectory(dirPath: string): Promise<CapabilityScanResult<SkillInfo>> {
    const skills: SkillInfo[] = []

    if (!(await fileExistsAtPath(dirPath)) || !(await isDirectory(dirPath))) {
        return completeScan(skills)
    }

    try {
        const entries = await fs.readdir(dirPath)

        for (const entryName of entries) {
            const entryPath = path.join(dirPath, entryName)
            const stats = await fs.stat(entryPath).catch(() => null)
            if (!stats?.isDirectory()) continue

            const skillMdPath = path.join(entryPath, "SKILL.md")
            if (!(await fileExistsAtPath(skillMdPath))) continue

            try {
                const fileContent = await fs.readFile(skillMdPath, "utf-8")
                const result = parseYamlFrontmatter(fileContent)
                if (result.parseError) {
                    Logger.warn("Failed to parse YAML frontmatter:", result.parseError)
                }
                const frontmatter = result.data

                // Validate required fields
                if (!frontmatter.name || typeof frontmatter.name !== "string") continue
                if (!frontmatter.description || typeof frontmatter.description !== "string") continue
                if (frontmatter.name !== entryName) continue

                skills.push(
                    SkillInfo.create({
                        name: entryName,
                        description: frontmatter.description,
                        path: skillMdPath,
                        enabled: true, // Will be updated with toggle state
                    }),
                )
            } catch {
                // Skip invalid skills
            }
        }
    } catch (error) {
        Logger.warn(`[CapabilityScan] Skills directory could not be read: ${dirPath}`, error)
        return incompleteScan(skills)
    }

    return completeScan(skills)
}

/**
 * Refreshes all skill toggles (discovers skills and their enabled state).
 *
 * Discovery is read-only: it reports what exists on disk and resolves the
 * effective state against stored preferences in memory. Persisting a preference
 * is reserved for explicit user toggles, so this stays off the storage write
 * path and never contends for the cross-process settings lock.
 */
export function refreshSkills(controller: Controller): Promise<RefreshedSkills> {
    // The skills tab polls this RPC directly while refreshRules() scans the same
    // directories on its own timer. Both entry points share one in-flight scan so
    // the panel cannot multiply filesystem walks on a large workspace.
    return coalesceCapabilityScan(controller, "skills", () => scanSkills(controller))
}

async function scanSkills(controller: Controller): Promise<RefreshedSkills> {
    const startedAt = performance.now()
    let scannedDirectories = 0
    // Get workspace paths for local skills
    const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
    const primaryWorkspace = workspacePaths.paths[0]

    const globalScans: CapabilityScanResult<SkillInfo>[] = []
    const localScans: CapabilityScanResult<SkillInfo>[] = []

    const scanDirs = getSkillsDirectoriesForScan(primaryWorkspace ?? "")
    for (const dir of scanDirs) {
        // Without an open workspace the local roots are not addressable, so
        // skipping them is a complete answer rather than a degraded scan.
        if (!primaryWorkspace && dir.source !== "global") continue
        scannedDirectories++
        const scan = await scanSkillsDirectory(dir.path)
        if (dir.source === "global") {
            globalScans.push(scan)
        } else {
            localScans.push(scan)
        }
    }

    const globalScan = mergeScans(globalScans)
    const localScan = mergeScans(localScans)
    const globalSkills: SkillInfo[] = [...globalScan.items]
    const localSkills: SkillInfo[] = [...localScan.items]

    // Resolve the discovered skills against the stored preferences without writing
    // them back. Remote entries use a separate name-keyed map and are handled below.
    const discoveredGlobalToggles = Object.fromEntries(globalSkills.map((skill) => [skill.path, true]))
    const globalToggles = resolveCapabilityToggles(controller.stateManager, "skills", discoveredGlobalToggles)
    for (const skill of globalSkills) {
        skill.enabled = globalToggles[skill.path] !== false
    }

    // Add remote skills from remote config.
    // Precedence: remote (enterprise) > disk-global (user) > project (workspace).
    // Remote entries are appended to globalSkills[] and split into the dedicated "Enterprise Skills"
    // section by the UI. The toggle store distinguishes them by the "remote:" path prefix.
    const remoteConfigSettings = controller.stateManager.getRemoteConfigSettings()
    const remoteSkillsToggles = controller.stateManager.getGlobalStateKey("remoteSkillsToggles") || {}
    const validatedRemoteSkills = parseRemoteSkillEntries(remoteConfigSettings.remoteGlobalSkills || [])

    for (const entry of validatedRemoteSkills) {
        const enabled = entry.alwaysEnabled || remoteSkillsToggles[entry.name] !== false

        globalSkills.push(
            SkillInfo.create({
                name: entry.name,
                description: entry.description,
                path: `remote:${entry.name}`,
                enabled,
                alwaysEnabled: entry.alwaysEnabled,
            }),
        )
    }

    // Resolve the workspace-level preferences the same way. Stale entries for
    // capabilities that no longer exist on disk are ignored here rather than
    // rewritten, which keeps discovery free of persistence side effects.
    const discoveredLocalToggles = Object.fromEntries(localSkills.map((skill) => [skill.path, true]))
    const localToggles = resolveCapabilityToggles(controller.stateManager, "skills", discoveredLocalToggles)
    rememberDiscoveredToggles(controller, "skills", discoveredLocalToggles, localScan.complete)
    for (const skill of localSkills) {
        skill.enabled = localToggles[skill.path] !== false
    }

    // Drop overrides whose skill no longer exists. Both roots feed the same
    // preference maps, so they are pruned together against one authoritative scan.
    const scanComplete = globalScan.complete && localScan.complete
    const discoveredIds = new Set([...globalScan.items, ...localScan.items].map((skill) => capabilityResourceId(skill.path)))
    await pruneCapabilityOrphans(controller.stateManager, "skills", discoveredIds, scanComplete)

    recordPerfPhase(
        PerfDomain.Capability,
        "skills_refresh",
        performance.now() - startedAt,
        {
            directories: scannedDirectories,
            global: globalSkills.length,
            local: localSkills.length,
            remote: validatedRemoteSkills.length,
            complete: scanComplete,
        },
        { taskId: controller.task?.taskId },
    )
    if (Logger.isDebugEnabled()) {
        Logger.debug(
            `[CapabilityPerf] phase=skills_refresh taskId=${controller.task?.taskId ?? "none"} durationMs=${Math.round(performance.now() - startedAt)} directories=${scannedDirectories} global=${globalSkills.length} local=${localSkills.length} remote=${validatedRemoteSkills.length} complete=${scanComplete}`,
        )
    }
    return RefreshedSkills.create({
        globalSkills,
        localSkills,
    })
}
