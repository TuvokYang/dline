import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { RipgrepSearchTimeoutError, regexSearchFiles } from "@services/ripgrep"
import { taskRipgrepScope } from "@services/ripgrep/cpu-budget"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import * as path from "path"
import { formatResponse } from "@/core/prompts/responses"
import { parseWorkspaceInlinePath } from "@/core/workspace/utils/parseWorkspaceInlinePath"
import { WorkspacePathAdapter } from "@/core/workspace/WorkspacePathAdapter"
import { resolveWorkspacePath } from "@/core/workspace/WorkspaceResolver"
import { telemetryService } from "@/services/telemetry"
import { ClineSayTool } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

/**
 * Match and file counts parsed out of one formatted ripgrep result block.
 *
 * `matches` and `files` are undefined when the output does not follow the
 * expected shape, so the UI can omit the scale suffix instead of showing a
 * wrong number. `truncated` means the backend capped the result set, making
 * `matches` a lower bound.
 */
export interface SearchStats {
	matches?: number
	files?: number
	truncated: boolean
}

/** Header emitted by formatResults when the result set hit the cap. */
const TRUNCATED_HEADER = /^Showing first (\d+) of \1\+ results\./
/** Header emitted by formatResults for a complete result set. */
const TOTAL_HEADER = /^Found ([\d,]+) results?\./
/** A file path line in formatted output is always followed by this separator. */
const FILE_SEPARATOR = "│----"

/**
 * Parse match and file counts from the formatted output of `regexSearchFiles`.
 *
 * The format is an internal contract of src/services/ripgrep: a count header,
 * a blank line, then per file a path line followed by `│----`. The same
 * separator also appears between and after result blocks, so a file is only
 * counted when its path line is preceded by a blank line.
 *
 * Unrecognized output yields undefined counts rather than zero.
 */
export function parseSearchStats(output: string): SearchStats {
	const lines = output.split("\n")
	const header = lines[0] ?? ""

	const truncatedMatch = header.match(TRUNCATED_HEADER)
	const totalMatch = header.match(TOTAL_HEADER)
	const countText = truncatedMatch?.[1] ?? totalMatch?.[1]
	if (countText === undefined) {
		return { truncated: false }
	}

	const matches = Number.parseInt(countText.replace(/,/g, ""), 10)

	let files = 0
	for (let i = 1; i < lines.length - 1; i++) {
		const isPathLine = lines[i] !== "" && lines[i] !== FILE_SEPARATOR
		if (isPathLine && lines[i - 1] === "" && lines[i + 1] === FILE_SEPARATOR) {
			files++
		}
	}

	return { matches, files, truncated: Boolean(truncatedMatch) }
}

/**
 * Combine per-workspace stats into one payload-level summary.
 *
 * Counts stay undefined unless at least one workspace reported usable numbers,
 * so a fully unparseable search does not render as "0 matches".
 */
function aggregateSearchStats(stats: SearchStats[]): SearchStats {
	let matches: number | undefined
	let files: number | undefined
	let truncated = false

	for (const stat of stats) {
		if (stat.matches != null) {
			matches = (matches ?? 0) + stat.matches
		}
		if (stat.files != null) {
			files = (files ?? 0) + stat.files
		}
		truncated ||= stat.truncated
	}

	return { matches, files, truncated }
}

export class SearchFilesToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.SEARCH

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.regex}'${
			block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
		}]`
	}

	/**
	 * Determines which paths to search based on workspace configuration and hints
	 */
	private determineSearchPaths(
		config: TaskConfig,
		parsedPath: string,
		workspaceHint: string | undefined,
		originalPath: string,
	): Array<{ absolutePath: string; workspaceName?: string; workspaceRoot?: string }> {
		if (config.isMultiRootEnabled && config.workspaceManager) {
			const adapter = new WorkspacePathAdapter({
				cwd: config.cwd,
				isMultiRootEnabled: true,
				workspaceManager: config.workspaceManager,
			})

			if (workspaceHint) {
				// Search only in the specified workspace
				const absolutePath = adapter.resolvePath(parsedPath, workspaceHint)
				const workspaceRoots = adapter.getWorkspaceRoots()
				const root = workspaceRoots.find((r) => r.name === workspaceHint)
				return [{ absolutePath, workspaceName: workspaceHint, workspaceRoot: root?.path }]
			}
			// As a fallback, perform the search across all available workspaces.
			// Typically, models should provide explicit hints to target specific workspaces for searching.
			const allPaths = adapter.getAllPossiblePaths(parsedPath)
			const workspaceRoots = adapter.getWorkspaceRoots()
			return allPaths.map((absPath, index) => ({
				absolutePath: absPath,
				workspaceName: workspaceRoots[index]?.name || path.basename(workspaceRoots[index]?.path || absPath),
				workspaceRoot: workspaceRoots[index]?.path,
			}))
		}
		// Single-workspace mode (backward compatible)
		// Absolute paths should be used as-is without prepending cwd
		if (path.isAbsolute(parsedPath)) {
			return [{ absolutePath: path.resolve(parsedPath), workspaceRoot: config.cwd }]
		}
		const pathResult = resolveWorkspacePath(config, originalPath, "SearchFilesTool.execute")
		const absolutePath = typeof pathResult === "string" ? pathResult : pathResult.absolutePath
		return [{ absolutePath, workspaceRoot: config.cwd }]
	}

	/**
	 * Executes a single search operation in a workspace
	 */
	private async executeSearch(
		config: TaskConfig,
		absolutePath: string,
		workspaceName: string | undefined,
		workspaceRoot: string | undefined,
		regex: string,
		filePattern: string | undefined,
	) {
		// A `.agentignore` restriction is a permission the workspace stated, so
		// naming the path directly must not widen it. Refusing here — rather
		// than returning an empty result — keeps the boundary visible instead of
		// inviting a shell command that would bypass it.
		//
		// The capability is probed rather than assumed: a controller that cannot
		// report exclusions leaves the decision to the search itself, which still
		// applies the full scan rules.
		const ignoreController = config.services.ignoreController
		const restricted =
			typeof ignoreController?.describeScanExclusion === "function" &&
			ignoreController.describeScanExclusion(absolutePath) === "agent-restricted"
		if (restricted) {
			return {
				workspaceName,
				workspaceResults: formatResponse.searchAgentRestricted(
					getReadablePath(workspaceRoot || config.cwd, absolutePath),
				),
				resultCount: 0,
				stats: { truncated: false } satisfies SearchStats,
				success: true,
			}
		}

		try {
			// Use workspace root for relative path calculation, fallback to cwd
			const basePathForRelative = workspaceRoot || config.cwd

			const workspaceResults = await regexSearchFiles(
				basePathForRelative,
				absolutePath,
				regex,
				filePattern,
				config.services.ignoreController,
				// Charge the walk to this task so one task cannot spend the whole
				// workspace ripgrep allowance on its own.
				taskRipgrepScope(config.taskId),
			)

			const stats = parseSearchStats(workspaceResults)

			return {
				workspaceName,
				workspaceResults,
				resultCount: stats.matches ?? 0,
				stats,
				success: true,
			}
		} catch (error) {
			// If search fails in one workspace, return error info
			Logger.error(`Search failed in ${absolutePath}:`, error)
			return {
				workspaceName,
				workspaceResults: "",
				resultCount: 0,
				stats: { truncated: false } satisfies SearchStats,
				success: false,
				failureMessage: error instanceof RipgrepSearchTimeoutError ? error.message : undefined,
			}
		}
	}

	/**
	 * Formats search results based on workspace configuration
	 */
	private formatSearchResults(
		config: TaskConfig,
		searchResults: Array<{
			workspaceName?: string
			workspaceResults: string
			resultCount: number
			stats: SearchStats
			success: boolean
			failureMessage?: string
		}>,
		searchPaths: Array<{ absolutePath: string; workspaceName?: string }>,
	): string {
		const allResults: string[] = []
		let totalResultCount = 0
		let anySuccess = false

		for (const { workspaceName, workspaceResults, resultCount, success } of searchResults) {
			if (!success || !workspaceResults) {
				continue
			}

			anySuccess = true
			totalResultCount += resultCount

			// If multi-workspace and we have results, annotate with workspace name
			if (config.isMultiRootEnabled && searchPaths.length > 1 && workspaceName) {
				// Check if this workspace has results (resultCount > 0)
				if (resultCount > 0) {
					// Skip the "Found X results" line and add workspace annotation
					const lines = workspaceResults.split("\n")
					// Skip first two lines (count and empty line) if they exist
					const resultsWithoutHeader = lines.length > 2 ? lines.slice(2).join("\n") : workspaceResults

					if (resultsWithoutHeader.trim()) {
						allResults.push(`## Workspace: ${workspaceName}\n${resultsWithoutHeader}`)
					}
				}
				// Don't add anything for workspaces with 0 results in multi-workspace mode
			} else if (!config.isMultiRootEnabled || searchPaths.length === 1) {
				// Single workspace mode or single workspace search
				allResults.push(workspaceResults)
			}
		}

		// If all searches failed, return a clear error message instead of misleading "Found 0 results."
		if (!anySuccess) {
			const timeoutMessages = [...new Set(searchResults.map((result) => result.failureMessage).filter(Boolean))]
			if (timeoutMessages.length > 0) {
				return `Search failed: ${timeoutMessages.join(" ")}`
			}
			const failedPaths = searchPaths.map((p) => p.absolutePath).join(", ")
			return `Search failed: unable to search in ${failedPaths}. This may be caused by ripgrep not being available or the search path not being accessible. Try a different directory path or check the tool requirements.`
		}

		// Combine results
		if (config.isMultiRootEnabled && searchPaths.length > 1) {
			// Multi-workspace search result
			if (totalResultCount === 0) {
				return getPrompt("toolHandlers", "searchNoResults")
			}
			return `Found ${totalResultCount === 1 ? "1 result" : `${totalResultCount.toLocaleString()} results`} across ${searchPaths.length} workspace${searchPaths.length > 1 ? "s" : ""}.\n\n${allResults.join("\n\n")}`
		}
		// Single workspace result
		return allResults[0] || getPrompt("toolHandlers", "searchNoResults")
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path
		const regex = block.params.regex

		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const filePattern = block.params.file_pattern

		const sharedMessageProps = {
			tool: "searchFiles",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: "",
			regex: uiHelpers.removeClosingTag(block, "regex", regex),
			filePattern: uiHelpers.removeClosingTag(block, "file_pattern", filePattern),
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		} satisfies ClineSayTool

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relDirPath: string | undefined = block.params.path
		const regex: string | undefined = block.params.regex
		const filePattern: string | undefined = block.params.file_pattern

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = resolveProvider(apiConfig, currentMode)

		// Validate required parameters
		const pathValidation = this.validator.assertRequiredParams(block, "path")
		if (!pathValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "path", undefined, block.ts)
		}
		if (!relDirPath) throw new Error("Validated search-files path is missing")

		if (!regex) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "regex", undefined, block.ts)
		}

		// Parse workspace hint from the path and determine search targets.
		// These can throw if the workspace configuration is invalid or the
		// path cannot be resolved, so catch and return a graceful tool error.
		let parsedPath: string
		let workspaceHint: string | undefined
		let searchPaths: ReturnType<SearchFilesToolHandler["determineSearchPaths"]>
		try {
			const parsed = parseWorkspaceInlinePath(relDirPath)
			parsedPath = parsed.relPath
			workspaceHint = parsed.workspaceHint
			searchPaths = this.determineSearchPaths(config, parsedPath, workspaceHint, relDirPath)
		} catch (error) {
			// Tool executed normally — returning a toolError result, not a tool crash.
			// Do NOT increment consecutiveMistakeCount: the model should see the error
			// and recover by trying a different path.
			const errorMessage = error instanceof Error ? error.message : String(error)
			return formatResponse.toolError(`Error resolving search path: ${errorMessage}`)
		}

		// Determine workspace context for telemetry
		const primaryWorkspaceRoot = searchPaths[0]?.workspaceRoot
		const resolvedToNonPrimary =
			searchPaths.length === 0
				? true
				: searchPaths.length > 1 || (primaryWorkspaceRoot ? !arePathsEqual(primaryWorkspaceRoot, config.cwd) : true)
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: !!workspaceHint,
			resolvedToNonPrimary,
			resolutionMethod: (workspaceHint ? "hint" : searchPaths.length > 1 ? "path_detection" : "primary_fallback") as
				| "hint"
				| "primary_fallback"
				| "path_detection",
		}

		// Capture workspace path resolution telemetry
		if (config.isMultiRootEnabled && config.workspaceManager) {
			const resolutionType = workspaceHint
				? "hint_provided"
				: searchPaths.length > 1
					? "cross_workspace_search"
					: "fallback_to_primary"
			telemetryService.captureWorkspacePathResolved(
				config.ulid ?? "",
				"SearchFilesToolHandler",
				resolutionType,
				workspaceHint ? "workspace_name" : undefined,
				searchPaths.length > 0, // resolution success = found paths to search
				undefined, // TODO: could calculate primary workspace index
				true,
			)
		}

		// Run PreToolUse before the first target search.
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) return formatResponse.toolDenied()
			throw error
		}

		// Execute searches in all relevant workspaces in parallel
		const searchPromises = searchPaths.map(({ absolutePath, workspaceName, workspaceRoot }) =>
			this.executeSearch(config, absolutePath, workspaceName, workspaceRoot, regex, filePattern),
		)

		// Wait for all searches to complete
		const searchStartTime = performance.now()
		const searchResults = await Promise.all(searchPromises)
		const searchDurationMs = performance.now() - searchStartTime

		// Format and combine results
		const results = this.formatSearchResults(config, searchResults, searchPaths)
		const stats = aggregateSearchStats(searchResults.filter((result) => result.success).map((result) => result.stats))

		// Only reset after a successful operation so repeated failures
		// accumulate toward the yolo-mode mistake limit.
		// If ALL searches failed, increment the mistake counter.
		const anySucceeded = searchResults.some((result) => result.success)
		if (anySucceeded) {
			config.taskState.consecutiveMistakeCount = 0
		}
		// If all searches failed, this is a tool result error (not a tool crash).
		// Do NOT increment consecutiveMistakeCount — the model should see the
		// failure and recover by trying different parameters.

		// Capture workspace search pattern telemetry
		if (config.isMultiRootEnabled && config.workspaceManager) {
			const searchType = workspaceHint ? "targeted" : searchPaths.length > 1 ? "cross_workspace" : "primary_only"
			const resultsFound = searchResults.some((result) => result.resultCount > 0)

			telemetryService.captureWorkspaceSearchPattern(
				config.ulid ?? "",
				searchType,
				searchPaths.length,
				!!workspaceHint,
				resultsFound,
				searchDurationMs,
			)
		}

		const sharedMessageProps = {
			tool: "searchFiles",
			path: getReadablePath(config.cwd, relDirPath),
			content: results,
			regex: regex,
			filePattern: filePattern,
			count: stats.matches,
			files: stats.files,
			truncated: stats.truncated,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(parsedPath),
		} satisfies ClineSayTool

		const completeMessage = JSON.stringify(sharedMessageProps)

		if (!config.isSubagentExecution) {
			await config.callbacks.say("tool", completeMessage, undefined, undefined, false, block.ts)
		}
		telemetryService.captureToolUsage(
			config.ulid ?? "",
			block.name,
			config.api.getModel().id,
			provider ?? "",
			!block.dline_tid || !config.admissionOutcomes?.has(block.dline_tid),
			true,
			workspaceContext,
			block.isNativeToolCall,
		)
		return results
	}
}
