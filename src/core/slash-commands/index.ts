import type { ApiProviderInfo } from "@core/api"
import type { ExplicitInstructionDeclaration } from "@core/task/explicit-instructions/types"
import { ClineRulesToggles } from "@shared/cline-rules"
import { McpPromptResponse } from "@shared/mcp"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"
import { pathToCommandName } from "@shared/slashCommands"
import { SLASH_TYPE_DESC } from "@shared/slashContext"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { ClineDefaultTool } from "@shared/tools"
import fs from "fs/promises"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import {
	deepPlanningToolResponse,
	explainChangesToolResponse,
	newRuleToolResponse,
	newTaskToolResponse,
	reportBugToolResponse,
} from "../prompts/commands"
import { StateManager } from "../storage/StateManager"
import { mergeScopedToggles, readScopedToggles } from "../storage/settings/capability-toggle-store"

/**
 * Callback type for fetching MCP prompts
 */
export type McpPromptFetcher = (serverName: string, promptName: string) => Promise<McpPromptResponse | null>

type FileBasedWorkflow = {
	fullPath: string
	fileName: string
	isRemote: false
}

type RemoteWorkflow = {
	fullPath: string
	fileName: string
	isRemote: true
	contents: string
}

type Workflow = FileBasedWorkflow | RemoteWorkflow

const USER_CONTENT_TAG_PATTERNS = [
	/<task>([\s\S]*?)<\/task>/i,
	/<feedback>([\s\S]*?)<\/feedback>/i,
	/<answer>([\s\S]*?)<\/answer>/i,
	/<user_message>([\s\S]*?)<\/user_message>/i,
]
const SLASH_COMMAND_IN_TEXT_REGEX = /(^|\s)\/([a-zA-Z0-9_.:@-]+)(?=\s|$)/

function parsePrefixedCommand(commandName: string): { prefix: string | null; name: string } {
	const colonIndex = commandName.indexOf(":")
	if (colonIndex === -1) {
		return { prefix: null, name: commandName }
	}
	return {
		prefix: commandName.substring(0, colonIndex),
		name: commandName.substring(colonIndex + 1),
	}
}

/**
 * Detect whether the first slash command in user-authored tagged content explicitly requests manual compaction.
 *
 * @param text Text block that may contain one user-content tag.
 * @returns True for /compact, /smol, /cmd:compact, or /cmd:smol when it is the first command parsed.
 */
export function hasManualCompactionCommand(text: string): boolean {
	for (const pattern of USER_CONTENT_TAG_PATTERNS) {
		const tagMatch = new RegExp(pattern.source, pattern.flags).exec(text)
		if (!tagMatch) continue

		const slashMatch = SLASH_COMMAND_IN_TEXT_REGEX.exec(tagMatch[1])
		if (!slashMatch) continue

		const commandName = slashMatch[2]
		const { prefix, name } = parsePrefixedCommand(commandName)
		const builtInName = prefix === "cmd" ? name : prefix === null ? commandName : undefined
		return builtInName === "compact" || builtInName === "smol"
	}

	return false
}

export interface SlashCommandParseResult {
	processedText: string
	needsClinerulesFileCheck: boolean
	explicitInstructions: readonly ExplicitInstructionDeclaration[]
}

const BUILTIN_EXPLICIT_INSTRUCTIONS: Readonly<Record<string, ExplicitInstructionDeclaration | undefined>> = {
	newtask: { type: "new_task", source: "slash_command", targetTool: ClineDefaultTool.NEW_TASK },
	smol: { type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
	compact: { type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
	newrule: { type: "new_rule", source: "slash_command", targetTool: ClineDefaultTool.NEW_RULE },
	reportbug: { type: "report_bug", source: "slash_command", targetTool: ClineDefaultTool.REPORT_BUG },
	"deep-planning": { type: "deep-planning", source: "slash_command", targetTool: ClineDefaultTool.NEW_TASK },
	"explain-changes": {
		type: "explain_changes",
		source: "slash_command",
		targetTool: ClineDefaultTool.GENERATE_EXPLANATION,
	},
}

export interface SlashCommandCapabilityContext {
	cwd: string
	capabilityToggles: TaskCapabilityToggles
	remoteSkills: GlobalInstructionsFile[]
	remoteWorkflows: GlobalInstructionsFile[]
}

export interface SlashCommandParseOptions {
	/** The caller has already isolated text from a trusted user-content tag. */
	trustedUserText?: boolean
}

/**
 * Processes text for slash commands and transforms them with appropriate instructions
 * This is called after parseMentions() to process any slash commands in the user's message
 */
export async function parseSlashCommands(
	text: string,
	localWorkflowToggles: ClineRulesToggles,
	globalWorkflowToggles: ClineRulesToggles,
	ulid: string,
	focusChainSettings?: { enabled: boolean },
	enableNativeToolCalls?: boolean,
	providerInfo?: Readonly<ApiProviderInfo>,
	mcpPromptFetcher?: McpPromptFetcher,
	capabilityContext?: SlashCommandCapabilityContext,
	options?: SlashCommandParseOptions,
): Promise<SlashCommandParseResult> {
	const SUPPORTED_DEFAULT_COMMANDS = ["newtask", "smol", "compact", "newrule", "reportbug", "deep-planning", "explain-changes"]
	const promptProfile = resolvePromptProfile({
		modelId: providerInfo?.model.id,
		contextWindow: providerInfo?.model.info.capabilities?.contextWindow,
	})
	const commandFocusChainSettings = promptProfile === "standard" ? focusChainSettings : undefined

	const commandReplacements: Record<string, string> = {
		newtask: newTaskToolResponse(),
		smol: "",
		compact: "",
		newrule: newRuleToolResponse(),
		reportbug: reportBugToolResponse(),
		"deep-planning": deepPlanningToolResponse(promptProfile, commandFocusChainSettings, providerInfo, enableNativeToolCalls),
		"explain-changes": explainChangesToolResponse(),
	}

	const tagPatterns = options?.trustedUserText
		? [{ regex: /^([\s\S]*)$/ }]
		: USER_CONTENT_TAG_PATTERNS.map((regex) => ({ regex }))

	// Regex to find slash commands anywhere in text (not just at the beginning).
	// This mirrors how @ mentions work - they can appear anywhere in a message.
	//
	// Pattern breakdown: /(^|\s)\/([a-zA-Z0-9_.:@-]+)(?=\s|$)/
	//   - (^|\s)  : Must be at start of string OR preceded by whitespace
	//   - \/      : The literal slash character
	//   - ([a-zA-Z0-9_.:@-]+) : The command name (letters, numbers, underscore, dot, hyphen, colon, @)
	//   - (?=\s|$): Must be followed by whitespace or end of string (lookahead)
	//
	// This safely avoids false matches in:
	//   - URLs: "http://example.com/newtask" - slash not preceded by whitespace
	//   - File paths: "some/path/newtask" - same reason
	//   - Partial words: "foo/bar" - same reason
	//
	// Only ONE slash command per message is processed (first match found).
	// Note: Colons are allowed to support prefix namespacing (cmd:, skills:, workflow:, mcp:)
	const slashCommandInTextRegex = SLASH_COMMAND_IN_TEXT_REGEX

	// Helper function to calculate positions and remove slash command from text
	const removeSlashCommand = (
		fullText: string,
		_tagContent: string, // kept for clarity about the context
		contentStartIndex: number,
		slashMatch: RegExpExecArray,
	): string => {
		// slashMatch.index is where the match starts (could include whitespace before /)
		// slashMatch[1] is the whitespace or empty string before the slash
		// slashMatch[2] is the command name
		const slashPositionInContent = slashMatch.index + slashMatch[1].length
		const slashPositionInFullText = contentStartIndex + slashPositionInContent
		const commandText = `/${slashMatch[2]}`
		const commandEndPosition = slashPositionInFullText + commandText.length

		return fullText.substring(0, slashPositionInFullText) + fullText.substring(commandEndPosition)
	}

	// if we find a valid match, we will return inside that block
	for (const { regex } of tagPatterns) {
		const regexObj = new RegExp(regex.source, regex.flags)
		const tagMatch = regexObj.exec(text)

		if (tagMatch) {
			const tagContent = tagMatch[1]
			const tagStartIndex = tagMatch.index
			const contentStartIndex = text.indexOf(tagContent, tagStartIndex)

			// Find slash command within the tag content
			const slashMatch = slashCommandInTextRegex.exec(tagContent)

			if (!slashMatch) {
				continue
			}

			// slashMatch[1] is the whitespace or empty string before the slash
			// slashMatch[2] is the command name (may include prefix like "cmd:newtask")
			const commandName = slashMatch[2] // casing matters
			const { prefix, name } = parsePrefixedCommand(commandName)

			// ── Route by prefix ──────────────────────────────────────────────
			if (prefix === "cmd" || (prefix === null && SUPPORTED_DEFAULT_COMMANDS.includes(commandName))) {
				// Prefixed format: /cmd:newtask
				// Legacy format:  /newtask (backward compatibility)
				const cmdName = prefix === "cmd" ? name : commandName
				if (SUPPORTED_DEFAULT_COMMANDS.includes(cmdName)) {
					const textWithoutSlashCommand = removeSlashCommand(text, tagContent, contentStartIndex, slashMatch)
					const processedText = commandReplacements[cmdName] + textWithoutSlashCommand

					telemetryService.captureSlashCommandUsed(ulid, cmdName, "builtin")

					return {
						processedText,
						needsClinerulesFileCheck: cmdName === "newrule",
						explicitInstructions: BUILTIN_EXPLICIT_INSTRUCTIONS[cmdName]
							? [BUILTIN_EXPLICIT_INSTRUCTIONS[cmdName]]
							: [],
					}
				}
			}

			// Check for MCP prompt commands (format: mcp:<server>:<prompt>)
			if (prefix === "mcp" && mcpPromptFetcher) {
				// name part may contain more colons: server:prompt
				const mcpParts = name.split(":")
				if (mcpParts.length >= 2) {
					const serverName = mcpParts[0]
					const promptName = mcpParts.slice(1).join(":")
					if (capabilityContext?.capabilityToggles.mcpServers[serverName] !== true) {
						return { processedText: text, needsClinerulesFileCheck: false, explicitInstructions: [] }
					}

					try {
						const promptResponse = await mcpPromptFetcher(serverName, promptName)
						if (promptResponse) {
							const promptContent = formatMcpPromptResponse(promptResponse)

							const textWithoutSlashCommand = removeSlashCommand(text, tagContent, contentStartIndex, slashMatch)
							const processedText =
								`<mcp_prompt server="${serverName}" prompt="${promptName}">\n${promptContent}\n</mcp_prompt>\n` +
								textWithoutSlashCommand

							telemetryService.captureSlashCommandUsed(ulid, commandName, "mcp_prompt")

							return { processedText, needsClinerulesFileCheck: false, explicitInstructions: [] }
						}
						Logger.debug(`MCP prompt not found: ${commandName} (server: ${serverName}, prompt: ${promptName})`)
					} catch (error) {
						Logger.error(`Error fetching MCP prompt ${commandName}: ${error}`)
					}
				}
			}

			// ── Skill matching (prefix: skills:) ─────────────────────────────
			// Injects Skill instructions directly without creating a load_skill tool call.
			if (prefix === "skills") {
				const skillName = name
				if (skillName) {
					const { discoverAvailableSkills, getSkillContent } = await import(
						"@core/context/instructions/user-instructions/skills"
					)
					const stateManager = capabilityContext ? undefined : StateManager.get()
					const remoteSkillEntries =
						capabilityContext?.remoteSkills ?? stateManager?.getRemoteConfigSettings().remoteGlobalSkills ?? []
					const availableSkills = await discoverAvailableSkills(capabilityContext?.cwd ?? "", {
						remoteSkillEntries,
						globalSkillsToggles:
							capabilityContext?.capabilityToggles.globalSkillsToggles ??
							stateManager?.getGlobalSettingsKey("globalSkillsToggles") ??
							{},
						localSkillsToggles:
							capabilityContext?.capabilityToggles.localSkillsToggles ??
							(stateManager ? mergeScopedToggles(readScopedToggles(stateManager, "skills")) : {}),
						remoteSkillsToggles:
							capabilityContext?.capabilityToggles.remoteSkillsToggles ??
							stateManager?.getGlobalStateKey("remoteSkillsToggles") ??
							{},
					})

					const skillContent = await getSkillContent(skillName, availableSkills, remoteSkillEntries)
					if (skillContent) {
						const textWithoutSlashCommand = removeSlashCommand(text, tagContent, contentStartIndex, slashMatch)
						const processedText =
							`<explicit_instructions type="skill" name="${skillName}" desc="${SLASH_TYPE_DESC.skill}">\n${skillContent.instructions}\n</explicit_instructions>\n` +
							textWithoutSlashCommand

						telemetryService.captureSlashCommandUsed(ulid, commandName, "skill")

						return {
							processedText,
							needsClinerulesFileCheck: false,
							explicitInstructions: [{ type: "skill", source: "skill_injection", metadata: { name: skillName } }],
						}
					}
				}
			}

			// ── Workflow matching (prefix: workflow: or legacy bare name) ────
			// Build workflow list (same as before but fileName uses pathToCommandName for strip .md)
			const globalWorkflows: Workflow[] = Object.entries(globalWorkflowToggles)
				.filter(([_, enabled]) => enabled)
				.map(([filePath, _]) => ({
					fullPath: filePath,
					fileName: pathToCommandName(filePath),
					isRemote: false,
				}))

			const localWorkflows: Workflow[] = Object.entries(localWorkflowToggles)
				.filter(([_, enabled]) => enabled)
				.map(([filePath, _]) => ({
					fullPath: filePath,
					fileName: pathToCommandName(filePath),
					isRemote: false,
				}))

			const stateManager = capabilityContext ? undefined : StateManager.get()
			const remoteWorkflows =
				capabilityContext?.remoteWorkflows ?? stateManager?.getRemoteConfigSettings().remoteGlobalWorkflows ?? []
			const remoteWorkflowToggles =
				capabilityContext?.capabilityToggles.remoteWorkflowToggles ??
				stateManager?.getGlobalStateKey("remoteWorkflowToggles") ??
				{}

			const enabledRemoteWorkflows: Workflow[] = remoteWorkflows
				.filter((workflow) => {
					return workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false
				})
				.map((workflow) => ({
					fullPath: "",
					fileName: workflow.name,
					isRemote: true,
					contents: workflow.contents,
				}))

			const enabledWorkflows: Workflow[] = [...localWorkflows, ...globalWorkflows, ...enabledRemoteWorkflows]

			// Match by name: prefixed "/workflow:xxx" or legacy "/xxx"
			const searchName = prefix === "workflow" ? name : commandName
			const matchingWorkflow = enabledWorkflows.find((workflow) => workflow.fileName === searchName)

			if (matchingWorkflow) {
				try {
					let workflowContent: string
					if (matchingWorkflow.isRemote) {
						workflowContent = matchingWorkflow.contents.trim()
					} else {
						workflowContent = (await fs.readFile(matchingWorkflow.fullPath, "utf8")).trim()
					}

					const textWithoutSlashCommand = removeSlashCommand(text, tagContent, contentStartIndex, slashMatch)
					const processedText =
						`<explicit_instructions type="workflow" name="${matchingWorkflow.fileName}" desc="${SLASH_TYPE_DESC.workflow}">\n${workflowContent}\n</explicit_instructions>\n` +
						textWithoutSlashCommand

					telemetryService.captureSlashCommandUsed(ulid, commandName, "workflow")

					return {
						processedText,
						needsClinerulesFileCheck: false,
						explicitInstructions: [
							{ type: "workflow", source: "workflow_injection", metadata: { name: matchingWorkflow.fileName } },
						],
					}
				} catch (error) {
					Logger.error(`Error reading workflow file ${matchingWorkflow.fullPath}: ${error}`)
				}
			}

			// ── Legacy fallback: bare command name matching workflow (with .md still on file name) ──
			// This handles old-style commands like /git-branch-analysis.md
			if (prefix === null) {
				const legacyWorkflows: Workflow[] = Object.entries(globalWorkflowToggles)
					.filter(([_, enabled]) => enabled)
					.map(([filePath, _]) => ({
						fullPath: filePath,
						fileName: filePath.replace(/^.*[/\\]/, ""), // keep .md for legacy
						isRemote: false,
					}))
				const legacyLocalWorkflows: Workflow[] = Object.entries(localWorkflowToggles)
					.filter(([_, enabled]) => enabled)
					.map(([filePath, _]) => ({
						fullPath: filePath,
						fileName: filePath.replace(/^.*[/\\]/, ""),
						isRemote: false,
					}))
				const legacyEnabledWorkflows = [...legacyLocalWorkflows, ...legacyWorkflows, ...enabledRemoteWorkflows]
				const legacyMatch = legacyEnabledWorkflows.find((wf) => wf.fileName === commandName)
				if (legacyMatch) {
					try {
						let workflowContent: string
						if (legacyMatch.isRemote) {
							workflowContent = legacyMatch.contents.trim()
						} else {
							workflowContent = (await fs.readFile(legacyMatch.fullPath, "utf8")).trim()
						}
						const textWithoutSlashCommand = removeSlashCommand(text, tagContent, contentStartIndex, slashMatch)
						const processedText =
							`<explicit_instructions type="workflow" name="${pathToCommandName(legacyMatch.fileName)}" desc="${SLASH_TYPE_DESC.workflow}">\n${workflowContent}\n</explicit_instructions>\n` +
							textWithoutSlashCommand

						telemetryService.captureSlashCommandUsed(ulid, commandName, "workflow")

						return {
							processedText,
							needsClinerulesFileCheck: false,
							explicitInstructions: [
								{
									type: "workflow",
									source: "workflow_injection",
									metadata: { name: pathToCommandName(legacyMatch.fileName) },
								},
							],
						}
					} catch (error) {
						Logger.error(`Error reading workflow file ${legacyMatch.fullPath}: ${error}`)
					}
				}
			}
		}
	}

	// if no supported commands are found, return the original text
	return { processedText: text, needsClinerulesFileCheck: false, explicitInstructions: [] }
}

/**
 * Formats MCP prompt response messages into a text format for injection
 */
export function formatMcpPromptResponse(response: McpPromptResponse): string {
	const parts: string[] = []

	if (response.description) {
		parts.push(`Description: ${response.description}`)
	}

	for (const message of response.messages) {
		const roleLabel = message.role === "user" ? "User" : "Assistant"

		if (message.content.type === "text") {
			parts.push(`[${roleLabel}]\n${message.content.text}`)
		} else if (message.content.type === "image") {
			parts.push(`[${roleLabel}]\n[Image: ${message.content.mimeType}]`)
		} else if (message.content.type === "audio") {
			parts.push(`[${roleLabel}]\n[Audio: ${message.content.mimeType}]`)
		} else if (message.content.type === "resource") {
			const resource = message.content.resource
			if (resource.text) {
				parts.push(`[${roleLabel}]\n[Resource: ${resource.uri}]\n${resource.text}`)
			} else {
				parts.push(`[${roleLabel}]\n[Resource: ${resource.uri}]`)
			}
		}
	}

	return parts.join("\n\n")
}
