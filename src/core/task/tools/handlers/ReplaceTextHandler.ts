import * as fs from "node:fs"
import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { getReadablePath } from "@utils/path"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { findReplaceTextFiles } from "../utils/replace-text-files"

interface MatchRecord {
	filePath: string
	line: number
	column: number
	before: string
	after: string
}

/**
 * Handles replace_text tool — global text replacement across files.
 * Two-phase rendering: partial shows header, execute updates content with match details.
 */
export class ReplaceTextHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.REPLACE_TEXT

	getDescription(block: ToolUse): string {
		const params = block.params as Record<string, unknown> | undefined
		const find = typeof params?.find === "string" ? params.find : "?"
		const fp = typeof params?.file_pattern === "string" ? params.file_pattern : "*"
		return `[replace_text] "${find}" in ${fp}`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const params = block.params as Record<string, unknown> | undefined
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) return

		const rawPath = params?.file_pattern ? String(params.file_pattern) : ""
		const find = params?.find ? String(params.find) : ""
		await uiHelpers.say(
			"tool",
			JSON.stringify({
				tool: "replaceText",
				path: rawPath,
				regex: find,
				operationIsLocatedInWorkspace: true,
			}),
			undefined,
			undefined,
			true,
			block.ts,
		)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const params = block.params as Record<string, unknown> | undefined
		const find = typeof params?.find === "string" ? params.find : ""
		const replace = typeof params?.replace === "string" ? params.replace : ""
		const filePattern = typeof params?.file_pattern === "string" ? params.file_pattern : "*"
		const dryRun = parseBooleanParam(params?.dry_run, false)
		const literal = parseBooleanParam(params?.literal, true)

		if (!find) {
			const result = getPrompt("replaceText", "missingFind")
			await settleReplaceTextUi(config, block, filePattern, find, result)
			return result
		}

		try {
			const searchRegex = literal ? buildLiteralRegex(find) : buildRegex(find)
			const files = await findReplaceTextFiles(config.cwd, filePattern)

			if (!files.length) {
				const result = renderPrompt("replaceText", "noFilesMatched", { PATTERN: filePattern })
				await settleReplaceTextUi(config, block, filePattern, find, result)
				return result
			}

			const allMatches: MatchRecord[] = []
			const fileContents = new Map<string, string>()

			for (const filePath of files) {
				try {
					const content = fs.readFileSync(filePath, "utf-8")
					const lines = content.split("\n")

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i]
						const matches = [...line.matchAll(searchRegex)]
						if (matches.length > 0) {
							const replaced = line.replace(searchRegex, replace)
							allMatches.push({
								filePath,
								line: i + 1,
								column: matches[0].index + 1,
								before: line.trim(),
								after: replaced.trim(),
							})
							lines[i] = replaced
						}
					}

					fileContents.set(filePath, lines.join("\n"))
				} catch {
					// skip unreadable files
				}
			}

			if (!allMatches.length) {
				const result = renderPrompt("replaceText", "noOccurrences", {
					FIND: find,
					COUNT: files.length,
					PATTERN: filePattern,
				})
				await settleReplaceTextUi(config, block, filePattern, find, result)
				return result
			}

			const uniqueFiles = new Set(allMatches.map((m) => m.filePath)).size
			const matchEntries = allMatches.map((m) => ({
				file: getReadablePath(config.cwd, m.filePath),
				line: m.line,
				column: m.column,
				originalText: find,
				newText: replace,
				diff: `- ${m.before}\n+ ${m.after}`,
			}))
			const diff = matchEntries.map((m) => m.diff).join("\n")
			const content = buildContent(config.cwd, find, replace, uniqueFiles, allMatches, dryRun)

			await config.callbacks.say(
				"tool",
				JSON.stringify({
					tool: "replaceText",
					path: filePattern,
					regex: find,
					diff,
					matches: matchEntries,
					files: uniqueFiles,
					count: allMatches.length,
					dryRun,
					content,
					operationIsLocatedInWorkspace: true,
				}),
				undefined,
				undefined,
				false,
				block.ts,
			)

			if (dryRun) return content

			let writeErrors = 0
			for (const [fPath, cnt] of fileContents) {
				try {
					fs.writeFileSync(fPath, cnt, "utf-8")
					// Track file modification for per-file checkpointing
					config.services.taskFileTracker.trackModification(fPath)
				} catch {
					writeErrors++
				}
			}

			let result = renderPrompt("replaceText", "successOutput", {
				FIND: find,
				REPLACE: replace,
				FILES: uniqueFiles,
				MATCHES: allMatches.length,
			})
			if (writeErrors > 0) {
				result += `\n${renderPrompt("replaceText", "writeErrors", { COUNT: writeErrors })}`
			}
			return result
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const result = renderPrompt("replaceText", "errorPrefix", { ERROR: message })
			await settleReplaceTextUi(config, block, filePattern, find, result)
			return result
		}
	}
}

function parseBooleanParam(value: unknown, defaultValue: boolean): boolean {
	if (value === true || value === "true") return true
	if (value === false || value === "false") return false
	return defaultValue
}

async function settleReplaceTextUi(
	config: TaskConfig,
	block: ToolUse,
	filePattern: string,
	find: string,
	content: string,
): Promise<void> {
	if (config.isSubagentExecution) return
	await config.callbacks.say(
		"tool",
		JSON.stringify({
			tool: "replaceText",
			path: filePattern,
			regex: find,
			content,
			operationIsLocatedInWorkspace: true,
		}),
		undefined,
		undefined,
		false,
		block.ts,
	)
}

function buildLiteralRegex(text: string): RegExp {
	const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return new RegExp(escaped, "g")
}

function buildRegex(pattern: string): RegExp {
	const match = pattern.match(/^\/(.+)\/([gimsuy]*)$/)
	try {
		if (match) {
			const flags = match[2].includes("g") ? match[2] : `${match[2]}g`
			return new RegExp(match[1], flags)
		}
		return new RegExp(pattern, "g")
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid regular expression: ${message}`, { cause: error })
	}
}

/**
 * Build content string with file:line:column and before/after text.
 */
function buildContent(
	cwd: string,
	find: string,
	replace: string,
	fileCount: number,
	matches: MatchRecord[],
	dryRun: boolean,
): string {
	let out = renderPrompt("replaceText", "dryRunHeader", {
		FIND: find,
		REPLACE: replace,
		FILES: fileCount,
		MATCHES: matches.length,
		PREVIEW: dryRun ? " (preview)" : "",
	})
	for (const m of matches) {
		const rel = getReadablePath(cwd, m.filePath)
		out += `\n${rel} L${m.line}:${m.column}\n  ${m.before}\n  ${m.after}\n`
	}
	if (dryRun) out += `\n${getPrompt("replaceText", "dryRunFooter")}`
	return out
}
