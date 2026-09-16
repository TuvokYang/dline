import { getSubagentsScanDirectories } from "@core/storage/disk"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import {
	type CapabilityScanResult,
	completeScan,
	incompleteScan,
	mergeScans,
} from "@core/storage/settings/capability-scan-result"
import { pruneCapabilityOrphans, resolveCapabilityToggles } from "@core/storage/settings/capability-toggle-store"
import { parseAgentConfigFromYaml } from "@core/task/tools/subagent/AgentConfigLoader"
import { isDefaultSubagentName } from "@core/task/tools/subagent/DefaultSubagentConfig"
import { sanitizeSubagentTools } from "@core/task/tools/subagent/subagent-tool-policy"
import { RefreshedSubagents, SubagentInfo } from "@shared/proto/dline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath, isDirectory } from "@/utils/fs"
import { Controller } from ".."
import { rememberDiscoveredToggles } from "./capability-discovery-cache"

/**
 * Scan a directory for subagent YAML config files.
 * Each .yml/.yaml file = one subagent.
 */
/** Track already-warned file paths to avoid log flooding during polling. */
const warnedPaths = new Set<string>()

/**
 * Reports whether the directory could be read. A missing directory is a
 * complete answer ("no subagents here"), but an unreadable one is not.
 */
async function scanSubagentsDirectory(dirPath: string): Promise<CapabilityScanResult<SubagentInfo>> {
	const subagents: SubagentInfo[] = []

	if (!(await fileExistsAtPath(dirPath)) || !(await isDirectory(dirPath))) {
		return completeScan(subagents)
	}

	try {
		const entries = await fs.readdir(dirPath)

		for (const entryName of entries) {
			if (!/\.(yaml|yml)$/i.test(entryName)) continue

			const filePath = path.join(dirPath, entryName)
			try {
				const content = await fs.readFile(filePath, "utf8")
				const config = parseAgentConfigFromYaml(content)

				// Clear warning on successful parse
				warnedPaths.delete(filePath)

				subagents.push(
					SubagentInfo.create({
						name: config.name,
						description: config.description,
						path: filePath,
						enabled: true, // Will be updated with toggle state
						// Report the allowlist the run will actually receive, not the
						// raw field. An empty field means "inherit the default list",
						// and forwarding it verbatim made the UI show every tool as
						// unselected; selecting one would then persist that single
						// tool and silently discard the inherited ones.
						tools: sanitizeSubagentTools(config.tools, {
							builtInDefault: isDefaultSubagentName(config.name),
							explicitlyNarrowed: config.toolsExplicitlyNarrowed === true,
						}),
						skills: config.skills || [],
						profile: config.profile ?? undefined,
					}),
				)
			} catch (error) {
				if (!warnedPaths.has(filePath)) {
					warnedPaths.add(filePath)
					Logger.warn(`Failed to parse subagent config: ${filePath}`, error)
				}
			}
		}
	} catch (error) {
		Logger.warn(`Failed to read subagents directory: ${dirPath}`, error)
		return incompleteScan(subagents)
	}

	return completeScan(subagents)
}

/**
 * Refreshes all subagent toggles (discovers subagents and their enabled state).
 *
 * Scan strategy:
 *   - Project: .agents/subagents/*.yml
 *   - Global:  ~/.agents/subagents/*.yml
 *   - Project overrides global on name collision.
 */
export async function refreshSubagents(controller: Controller): Promise<RefreshedSubagents> {
	const startedAt = performance.now()
	let scannedDirectories = 0
	try {
		// Get workspace paths for local subagents
		const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
		const primaryWorkspace = workspacePaths.paths[0]

		const globalScans: CapabilityScanResult<SubagentInfo>[] = []
		const localScans: CapabilityScanResult<SubagentInfo>[] = []

		const scanDirs = getSubagentsScanDirectories(primaryWorkspace ?? "")
		for (const dir of scanDirs) {
			// Without an open workspace the local roots are not addressable, so
			// skipping them is a complete answer rather than a degraded scan.
			if (!primaryWorkspace && dir.source !== "global") continue
			scannedDirectories++
			const scan = await scanSubagentsDirectory(dir.path)
			if (dir.source === "global") {
				globalScans.push(scan)
			} else {
				localScans.push(scan)
			}
		}

		const globalScan = mergeScans(globalScans)
		const localScan = mergeScans(localScans)
		const globalSubagents: SubagentInfo[] = [...globalScan.items]
		const localSubagents: SubagentInfo[] = [...localScan.items]

		// Resolve the filesystem snapshot against the stored preferences in memory.
		// Newly discovered files get the same default as the existing capability
		// pickers, and entries for deleted files are ignored rather than rewritten,
		// which keeps discovery off the storage write path.
		const localNames = new Set(localSubagents.map((agent) => agent.name))
		const visibleGlobalSubagents = globalSubagents.filter((agent) => !localNames.has(agent.name))
		const discoveredGlobalToggles = Object.fromEntries(globalSubagents.map((agent) => [agent.path, true]))
		const globalToggles = resolveCapabilityToggles(controller.stateManager, "subagents", discoveredGlobalToggles)
		for (const agent of visibleGlobalSubagents) {
			agent.enabled = globalToggles[agent.path] !== false
		}

		const discoveredLocalToggles = Object.fromEntries(localSubagents.map((agent) => [agent.path, true]))
		const localToggles = resolveCapabilityToggles(controller.stateManager, "subagents", discoveredLocalToggles)
		// The state push needs to know which resources exist. Discovery no longer
		// writes its result into the preference store, so remember it here instead.
		rememberDiscoveredToggles(controller, "subagents", discoveredLocalToggles, localScan.complete)
		for (const agent of localSubagents) {
			agent.enabled = localToggles[agent.path] !== false
		}

		// Drop overrides whose subagent no longer exists. Shadowed global agents
		// still exist on disk, so the raw scan items decide, not the visible set.
		const scanComplete = globalScan.complete && localScan.complete
		const discoveredIds = new Set([...globalScan.items, ...localScan.items].map((agent) => capabilityResourceId(agent.path)))
		await pruneCapabilityOrphans(controller.stateManager, "subagents", discoveredIds, scanComplete)

		recordPerfPhase(
			PerfDomain.Capability,
			"subagents_refresh",
			performance.now() - startedAt,
			{
				directories: scannedDirectories,
				global: visibleGlobalSubagents.length,
				local: localSubagents.length,
				shadowedGlobal: globalSubagents.length - visibleGlobalSubagents.length,
				complete: scanComplete,
			},
			{ taskId: controller.task?.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[CapabilityPerf] phase=subagents_refresh taskId=${controller.task?.taskId ?? "none"} durationMs=${Math.round(performance.now() - startedAt)} directories=${scannedDirectories} global=${visibleGlobalSubagents.length} local=${localSubagents.length} shadowedGlobal=${globalSubagents.length - visibleGlobalSubagents.length} complete=${scanComplete}`,
			)
		}
		return RefreshedSubagents.create({
			globalSubagents: visibleGlobalSubagents,
			localSubagents,
		})
	} catch (error) {
		Logger.error("refreshSubagents failed:", error)
		recordPerfPhase(
			PerfDomain.Capability,
			"subagents_refresh_error",
			performance.now() - startedAt,
			{ directories: scannedDirectories },
			{ taskId: controller.task?.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[CapabilityPerf] phase=subagents_refresh_error taskId=${controller.task?.taskId ?? "none"} durationMs=${Math.round(performance.now() - startedAt)} directories=${scannedDirectories}`,
			)
		}
		return RefreshedSubagents.create({
			globalSubagents: [],
			localSubagents: [],
		})
	}
}
