import {
	combineRuleToggles,
	getRuleFilesTotalContent,
	readDirectoryRecursive,
	scanRuleToggles,
} from "@core/context/instructions/user-instructions/rule-helpers"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { formatResponse } from "@core/prompts/responses"
import { GlobalFileNames } from "@core/storage/disk"
import { resolveCapabilityToggles } from "@core/storage/settings/capability-toggle-store"
import { listFiles } from "@services/glob/list-files"
import { ClineRulesToggles } from "@shared/cline-rules"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import fs from "fs/promises"
import path from "path"
import { Controller } from "@/core/controller"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"

/** One editor-rule family's raw scan: what exists, and whether the scan is trustworthy. */
export interface ExternalRuleDiscovery {
	readonly toggles: ClineRulesToggles
	readonly complete: boolean
}

export interface ExternalRulesRefresh {
	windsurfLocalToggles: ClineRulesToggles
	cursorLocalToggles: ClineRulesToggles
	agentsLocalToggles: ClineRulesToggles
	discovered: {
		windsurfRules: ExternalRuleDiscovery
		cursorRules: ExternalRuleDiscovery
		agentsRules: ExternalRuleDiscovery
	}
}

/**
 * Refreshes the toggles for windsurf, cursor, and agents rules.
 *
 * Discovery is read-only: it reports what exists on disk and resolves the
 * effective state against stored preferences in memory. Persisting a preference
 * is reserved for explicit user toggles, so this stays off the storage write
 * path and never contends for the cross-process settings lock.
 */
export async function refreshExternalRulesToggles(
	controller: Controller,
	workingDirectory: string,
): Promise<ExternalRulesRefresh> {
	const startedAt = performance.now()
	// local windsurf toggles
	const localWindsurfRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.windsurfRules)
	const windsurfScan = await scanRuleToggles(localWindsurfRulesFilePath, {})
	const updatedLocalWindsurfToggles = resolveCapabilityToggles(controller.stateManager, "windsurfRules", windsurfScan.toggles)

	// cursor has two valid locations for rules files, so we need to check both and combine
	// each scan drops whichever rules files are not in its own path, but combining the results avoids data loss
	let localCursorRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.cursorRulesDir)
	const cursorDirScan = await scanRuleToggles(localCursorRulesFilePath, {}, ".mdc")

	localCursorRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.cursorRulesFile)
	const cursorFileScan = await scanRuleToggles(localCursorRulesFilePath, {})

	const discoveredCursor = combineRuleToggles(cursorDirScan.toggles, cursorFileScan.toggles)
	const updatedLocalCursorToggles = resolveCapabilityToggles(controller.stateManager, "cursorRules", discoveredCursor)

	// local agents toggles
	const localAgentsRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.agentsRulesFile)
	const agentsScan = await scanRuleToggles(localAgentsRulesFilePath, {})
	const updatedLocalAgentsToggles = resolveCapabilityToggles(controller.stateManager, "agentsRules", agentsScan.toggles)
	recordPerfPhase(
		PerfDomain.Capability,
		"external_rules_refresh",
		performance.now() - startedAt,
		{
			windsurf: Object.keys(updatedLocalWindsurfToggles).length,
			cursor: Object.keys(updatedLocalCursorToggles).length,
			agents: Object.keys(updatedLocalAgentsToggles).length,
		},
		{ taskId: controller.task?.taskId },
	)
	if (Logger.isDebugEnabled()) {
		Logger.debug(
			`[CapabilityPerf] phase=external_rules_refresh taskId=${controller.task?.taskId ?? "none"} durationMs=${Math.round(performance.now() - startedAt)} windsurf=${Object.keys(updatedLocalWindsurfToggles).length} cursor=${Object.keys(updatedLocalCursorToggles).length} agents=${Object.keys(updatedLocalAgentsToggles).length}`,
		)
	}

	return {
		windsurfLocalToggles: updatedLocalWindsurfToggles,
		cursorLocalToggles: updatedLocalCursorToggles,
		agentsLocalToggles: updatedLocalAgentsToggles,
		// The raw scans say which files exist; the resolved maps above already
		// fold in the user's overrides and cannot answer that question. Cursor
		// reads from two roots, so one unreadable root taints its result.
		discovered: {
			windsurfRules: { toggles: windsurfScan.toggles, complete: windsurfScan.complete },
			cursorRules: { toggles: discoveredCursor, complete: cursorDirScan.complete && cursorFileScan.complete },
			agentsRules: { toggles: agentsScan.toggles, complete: agentsScan.complete },
		},
	}
}

/**
 * Gather formatted windsurf rules
 */
export const getLocalWindsurfRules = async (cwd: string, toggles: ClineRulesToggles, workspaceName = path.basename(cwd)) => {
	const windsurfRulesFilePath = path.resolve(cwd, GlobalFileNames.windsurfRules)

	let windsurfRulesFileInstructions: string | undefined

	if (await fileExistsAtPath(windsurfRulesFilePath)) {
		if (!(await isDirectory(windsurfRulesFilePath))) {
			try {
				if (windsurfRulesFilePath in toggles && toggles[windsurfRulesFilePath] !== false) {
					const ruleFileContent = (await fs.readFile(windsurfRulesFilePath, "utf8")).trim()
					if (ruleFileContent) {
						windsurfRulesFileInstructions = formatResponse.windsurfRulesLocalFileInstructions(
							workspaceName,
							ruleFileContent,
						)
					}
				}
			} catch {
				Logger.error(`Failed to read .windsurfrules file at ${windsurfRulesFilePath}`)
			}
		}
	}

	return windsurfRulesFileInstructions
}

/**
 * Gather formatted cursor rules, which can come from two sources
 */
export const getLocalCursorRules = async (cwd: string, toggles: ClineRulesToggles, workspaceName = path.basename(cwd)) => {
	// we first check for the .cursorrules file
	const cursorRulesFilePath = path.resolve(cwd, GlobalFileNames.cursorRulesFile)
	let cursorRulesFileInstructions: string | undefined

	if (await fileExistsAtPath(cursorRulesFilePath)) {
		if (!(await isDirectory(cursorRulesFilePath))) {
			try {
				if (cursorRulesFilePath in toggles && toggles[cursorRulesFilePath] !== false) {
					const ruleFileContent = (await fs.readFile(cursorRulesFilePath, "utf8")).trim()
					if (ruleFileContent) {
						cursorRulesFileInstructions = formatResponse.cursorRulesLocalFileInstructions(
							workspaceName,
							ruleFileContent,
						)
					}
				}
			} catch {
				Logger.error(`Failed to read .cursorrules file at ${cursorRulesFilePath}`)
			}
		}
	}

	// we then check for the .cursor/rules dir
	const cursorRulesDirPath = path.resolve(cwd, GlobalFileNames.cursorRulesDir)
	let cursorRulesDirInstructions: string | undefined

	if (await fileExistsAtPath(cursorRulesDirPath)) {
		if (await isDirectory(cursorRulesDirPath)) {
			try {
				const rulesScan = await readDirectoryRecursive(cursorRulesDirPath, ".mdc")
				const rulesFilesTotalContent = await getRuleFilesTotalContent([...rulesScan.items], cwd, toggles)
				if (rulesFilesTotalContent) {
					cursorRulesDirInstructions = formatResponse.cursorRulesLocalDirectoryInstructions(
						workspaceName,
						rulesFilesTotalContent,
					)
				}
			} catch {
				Logger.error(`Failed to read .cursor/rules directory at ${cursorRulesDirPath}`)
			}
		}
	}

	return [cursorRulesFileInstructions, cursorRulesDirInstructions]
}

/**
 * Helper function to find all agents.md files recursively (case-insensitive)
 * Only searches if a top-level agents.md file exists
 */
async function findAgentsMdFiles(cwd: string, ignoreController?: IgnoreController): Promise<string[]> {
	try {
		// First check if top-level agents.md exists
		const topLevelAgentsPath = path.resolve(cwd, GlobalFileNames.agentsRulesFile)
		const topLevelExists = await fileExistsAtPath(topLevelAgentsPath)

		// Only search recursively if top-level agents.md exists
		if (!topLevelExists) {
			return []
		}

		// Search recursively for all agents.md files. `listFiles` yields FileInfo
		// entries, so map to the path: returning the entries themselves made every
		// downstream `path.resolve` throw and silently dropped all agents rules.
		const [allFiles] = await listFiles(cwd, true, 500, { ignoreController })
		const agentsFileName = GlobalFileNames.agentsRulesFile.toLowerCase()
		return allFiles
			.filter((info) => !info.isDirectory && path.basename(info.path).toLowerCase() === agentsFileName)
			.map((info) => info.path)
	} catch (error) {
		Logger.error(`Failed to find agents.md files in ${cwd}:`, error)
		return []
	}
}

/**
 * Gather formatted agents rules - searches recursively and combines all agents.md files
 */
export const getLocalAgentsRules = async (
	cwd: string,
	toggles: ClineRulesToggles,
	ignoreController?: IgnoreController,
	workspaceName = path.basename(cwd),
) => {
	const agentsRulesFilePath = path.resolve(cwd, GlobalFileNames.agentsRulesFile)

	// Check if the top-level agents.md file is enabled
	if (agentsRulesFilePath in toggles && toggles[agentsRulesFilePath] === false) {
		return undefined
	}

	try {
		const agentsMdFiles = await findAgentsMdFiles(cwd, ignoreController)

		if (agentsMdFiles.length === 0) {
			return undefined
		}

		// Read and combine all agents.md files
		const combinedContent = await Promise.all(
			agentsMdFiles.map(async (filePath) => {
				try {
					const fullPath = path.resolve(cwd, filePath)
					const content = (await fs.readFile(fullPath, "utf8")).trim()
					if (content) {
						const relativePath = path.relative(cwd, fullPath)
						return `## ${relativePath}\n\n${content}`
					}
					return null
				} catch (error) {
					Logger.error(`Failed to read agents.md file at ${filePath}:`, error)
					return null
				}
			}),
		).then((contents) => contents.filter(Boolean).join("\n\n"))

		if (combinedContent) {
			return formatResponse.agentsRulesLocalFileInstructions(workspaceName, combinedContent)
		}
	} catch (error) {
		Logger.error("Failed to read agents.md files:", error)
	}

	return undefined
}
