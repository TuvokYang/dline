import { renderCapabilitiesForContext } from "../capabilities/CapabilitiesSection"
import { getPrompt } from "../i18n"
import type { SystemPromptContext } from "../system-prompt/context"
import {
	assembleSystemPrompt,
	createSystemPromptConfig,
	prepareSystemRuntimeEnv,
	prepareToolUseSection,
} from "../system-prompt/pipeline"
import { INTEGRATED_SYSTEM_TEMPLATE, SystemTemplateRegistry } from "../system-prompt/templates/system-template-registry"
import { createLiteSystemSections, createStandardSystemSections } from "../system-prompt/variants/section-content"
import { ToolPromptGenerator } from "./ToolPromptGenerator"
import type { GeneratedSystemPrompt } from "./types"

const TEMPLATE_REGISTRY = new SystemTemplateRegistry([INTEGRATED_SYSTEM_TEMPLATE])
const MARKDOWN_SECTION_SEPARATOR = "\n\n"

/** Generates complete Standard/Lite system prompt candidates without legacy registries. */
export class SystemPromptGenerator {
	/** Creates a profile system generator with an injectable tool facade. */
	public constructor(private readonly toolGenerator: ToolPromptGenerator = new ToolPromptGenerator()) {}

	/**
	 * Generates a profile prompt and optional provider tools from explicit context.
	 *
	 * @param context Complete system prompt runtime context.
	 * @returns Generated prompt text, profile, warnings, and ordered tools.
	 */
	public async generate(context: SystemPromptContext): Promise<GeneratedSystemPrompt> {
		const config = createSystemPromptConfig(context)
		const template = TEMPLATE_REGISTRY.get(config.templateId)
		const env = prepareSystemRuntimeEnv(context, config)
		const sections = new Map(
			config.variant === "lite" ? createLiteSystemSections(config) : createStandardSystemSections(config),
		)
		const capabilities =
			context.capabilities ??
			(context.skills?.length
				? {
						mcp: [],
						skills: context.skills.map((skill) => ({ name: skill.name, description: skill.description })),
						workflows: [],
						subagents: [],
					}
				: undefined)
		const capabilitiesSection = capabilities
			? renderCapabilitiesForContext(capabilities, {
					profile: config.variant,
					subagentsEnabled: context.subagentsEnabled,
					disableTools: context.disableTools,
				})
			: config.variant === "lite"
				? ""
				: context.capabilitiesSection
		if (capabilitiesSection?.trim()) {
			const capabilityHeading = getPrompt("capabilityCatalog", "heading")
			const capabilityGroups = capabilitiesSection.trim().replace(new RegExp(`^${capabilityHeading}\\s*`, "i"), "")
			if (capabilityGroups) {
				sections.set("capabilities", `${sections.get("capabilities") ?? ""}\n\n${capabilityGroups}`)
			}
		}
		const xmlTools = config.transport === "xml" ? this.toolGenerator.generateXml(config.variant, context) : ""
		sections.set("tool-use", prepareToolUseSection(config, sections.get("tool-use") ?? "", xmlTools))
		const output = assembleSystemPrompt(template.sectionIds, sections, MARKDOWN_SECTION_SEPARATOR, env)

		return {
			systemPrompt: output.text,
			tools: this.toolGenerator.generate(config.variant, context),
			profile: config.variant,
			warnings: output.warnings,
			trace: output.trace,
		}
	}
}
