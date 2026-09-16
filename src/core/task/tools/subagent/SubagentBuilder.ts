import { buildApiHandler, buildApiHandlerFromProfile } from "@core/api"
import { applyTaskRuntimeOverrides } from "@core/api/runtime-profile"
import { readApiProfiles } from "@core/controller/file/getApiProfiles"
import { resolveProfileReference } from "@core/profiles/profile-binding"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { resolveProfileReasoningConfig } from "@shared/task-reasoning"
import { ClineDefaultTool } from "@shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import type { AgentBaseConfig } from "./AgentConfigLoader"
import { DEFAULT_SUBAGENT_ALLOWED_TOOLS, isDefaultSubagentName } from "./DefaultSubagentConfig"
import { sanitizeSubagentTools } from "./subagent-tool-policy"

export type AgentConfig = Partial<AgentBaseConfig>

type SubagentProfileSource = "configured" | "parent_fallback"

interface SubagentProfileSelection {
	readonly profile: ApiProfile | undefined
	readonly profileName: string | undefined
	readonly profileId: string | undefined
	readonly source: SubagentProfileSource
}

export const SUBAGENT_DEFAULT_ALLOWED_TOOLS = DEFAULT_SUBAGENT_ALLOWED_TOOLS

export const SUBAGENT_COMPLETION_CONTRACT = `# Required Completion Protocol
A subagent run can finish and return to its parent only by calling the attempt_completion tool with a non-empty result field.
Plain assistant text cannot complete a subagent run, even when it contains final findings, an error, or a blocker.
When the work is complete or cannot proceed, call attempt_completion and put the full findings or blocker in result.`

export const SUBAGENT_SYSTEM_SUFFIX = `# Subagent Execution Mode
You are running as a research subagent. Your job is to explore the codebase and gather information to answer the question.
Explore, read related files, trace through call chains, and build a complete picture before reporting back.
Use only the tools exposed for this subagent profile.
Unless the subagent prompt explicitly asks for detailed analysis, keep the result concise and focus on the files the main agent should read next.
Include a section titled "Relevant file paths" and list only file paths, one per line.
Do not include line numbers, summaries, or per-file explanations unless explicitly requested.

${SUBAGENT_COMPLETION_CONTRACT}`

export class SubagentBuilder {
	private readonly agentConfig: AgentConfig = {}
	private readonly allowedTools: ClineDefaultTool[]
	private readonly apiHandler: ReturnType<typeof buildApiHandler>
	private readonly profileId: string | undefined
	private readonly profileName: string | undefined
	private readonly reasoningConfig: ReturnType<typeof resolveProfileReasoningConfig>

	constructor(
		private readonly baseConfig: TaskConfig,
		subagentName?: string,
		agentConfig?: AgentBaseConfig,
	) {
		this.agentConfig = agentConfig ?? {}
		this.allowedTools = this.resolveAllowedTools(
			this.agentConfig.tools,
			!subagentName || isDefaultSubagentName(subagentName),
			this.agentConfig.toolsExplicitlyNarrowed === true,
		)

		const apiConfiguration = this.baseConfig.services.stateManager.getApiConfigurationForTask(this.baseConfig.taskId)
		const profiles = readApiProfiles()
		const profileSelection = this.resolveProfile(
			profiles,
			this.agentConfig.profile,
			apiConfiguration.actModeProfileId ?? apiConfiguration.actModeProfile,
			apiConfiguration.actModeProfile,
			this.agentConfig.tools?.includes(ClineDefaultTool.GENERATE_IMAGE) === true,
		)
		this.profileName = profileSelection.profileName
		this.profileId = profileSelection.profileId
		const effectiveApiConfiguration = {
			...apiConfiguration,
			actModeProfileId: profileSelection.profileId,
			actModeProfile: this.profileName,
			actModeReasoningOverride:
				profileSelection.source === "configured" ? undefined : apiConfiguration.actModeReasoningOverride,
			ulid: this.baseConfig.ulid,
		}
		const profile = profileSelection.profile
		const runtimeProfile = profile ? applyTaskRuntimeOverrides(profile, effectiveApiConfiguration, "act") : undefined
		this.reasoningConfig = resolveProfileReasoningConfig(runtimeProfile)
		this.apiHandler = profile
			? buildApiHandlerFromProfile(effectiveApiConfiguration, "act", profile)
			: buildApiHandler(effectiveApiConfiguration, "act")
	}

	getApiHandler(): ReturnType<typeof buildApiHandler> {
		return this.apiHandler
	}

	getAllowedTools(): ClineDefaultTool[] {
		return this.allowedTools
	}

	getConfiguredSkills(): string[] | undefined {
		return this.agentConfig.skills
	}

	getConfiguredMaxOutputTokens(): number | undefined {
		return this.agentConfig.maxOutputTokens
	}

	getProfileId(): string | undefined {
		return this.profileId
	}

	getProfileName(): string | undefined {
		return this.profileName
	}

	getReasoningConfig(): ReturnType<typeof resolveProfileReasoningConfig> {
		return this.reasoningConfig
	}

	buildSystemPrompt(generatedSystemPrompt: string): string {
		const configuredSystemPrompt = this.agentConfig.systemPrompt?.trim()
		const sections = [
			generatedSystemPrompt.trim(),
			configuredSystemPrompt ? `# Subagent Custom Instructions\n${configuredSystemPrompt}` : "",
			this.buildAgentIdentitySystemPrefix(),
			SUBAGENT_SYSTEM_SUFFIX,
		]
		return sections.filter(Boolean).join("\n\n")
	}

	/**
	 * Resolve the effective act profile for a subagent.
	 *
	 * @param profiles Catalog Profiles available to the current process.
	 * @param configuredProfile Optional profile name from subagent YAML.
	 * @param parentProfileReference Stable ID or legacy name bound to the parent Act mode.
	 * @param parentProfileName Parent display name retained for the existing invalid-profile error path.
	 * @param requireExplicitProfile Whether the subagent exposes generate_image and must bind its own Profile.
	 * @returns Selected Profile snapshot and whether it is an explicit child binding or parent fallback.
	 */
	private resolveProfile(
		profiles: ReturnType<typeof readApiProfiles>,
		configuredProfile: string | null | undefined,
		parentProfileReference: string | undefined,
		parentProfileName: string | undefined,
		requireExplicitProfile = false,
	): SubagentProfileSelection {
		const parentResolution = resolveProfileReference(profiles, parentProfileReference)
		const parentProfile =
			parentResolution.status === "resolved" && parentResolution.profile.enabled ? parentResolution.profile : undefined
		const parentFallback: SubagentProfileSelection = {
			profile: parentProfile,
			profileName: parentProfile?.name ?? parentProfileName,
			profileId: parentProfile?.id,
			source: "parent_fallback",
		}
		const profileName = configuredProfile?.trim()
		if (!profileName) {
			// Image generation must never inherit parent credentials: without an explicit
			// binding the subagent has no authorized image source, so fail closed.
			if (requireExplicitProfile) {
				throw new Error("Subagents configured with generate_image require an explicit API Profile.")
			}
			return parentFallback
		}

		const resolution = resolveProfileReference(profiles, profileName)
		if (resolution.status !== "resolved") {
			if (requireExplicitProfile) {
				throw new Error(`Subagent image Profile '${profileName}' is unavailable or not enabled for subagents.`)
			}
			return parentFallback
		}
		const profile = resolution.profile
		if (!profile.enabled || !profile.usedFor.includes("subagents")) {
			if (requireExplicitProfile) {
				throw new Error(`Subagent image Profile '${profileName}' is unavailable or not enabled for subagents.`)
			}
			return parentFallback
		}

		return { profile, profileName: profile.name, profileId: profile.id, source: "configured" }
	}

	/**
	 * Resolve allowed subagent tools from config and defaults.
	 *
	 * Delegates to the shared policy so the enforced allowlist, the capability
	 * catalogue, and the selection UI cannot drift apart.
	 *
	 * @param configuredTools Optional YAML configured tools.
	 * @param builtInDefault Whether this run uses the built-in default profile.
	 * @param explicitlyNarrowed Whether the author wrote a list that policy
	 *   rejected entirely, which must not be widened back to the default set.
	 * @returns De-duplicated tool allowlist with the subagent tool policy applied.
	 */
	private resolveAllowedTools(
		configuredTools: ClineDefaultTool[] | undefined,
		builtInDefault: boolean,
		explicitlyNarrowed: boolean,
	): ClineDefaultTool[] {
		return sanitizeSubagentTools(configuredTools, { builtInDefault, explicitlyNarrowed })
	}

	/**
	 * Build an identity section for configured subagents.
	 * @returns Agent identity prompt section or empty text.
	 */
	private buildAgentIdentitySystemPrefix(): string {
		const name = this.agentConfig?.name?.trim()
		const description = this.agentConfig?.description?.trim()
		if (!name && !description) {
			return ""
		}

		const lines = ["# Agent Profile"]
		if (name) {
			lines.push(`Name: ${name}`)
		}
		if (description) {
			lines.push(`Description: ${description}`)
		}

		return lines.join("\n")
	}
}
