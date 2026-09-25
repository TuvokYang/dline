export const SYSTEM_SECTION_IDS = [
	"agent-role",
	"user-authority",
	"act-vs-plan",
	"user-communication",
	"tool-use",
	"task-progress",
	"capabilities",
	"objective",
	"execution",
	"system-info",
	"feedback",
	"user-instructions",
] as const

export type SystemSectionId = (typeof SYSTEM_SECTION_IDS)[number]

export interface SystemTemplateDefinition {
	readonly id: string
	readonly sectionIds: readonly SystemSectionId[]
}

export const INTEGRATED_SYSTEM_TEMPLATE: SystemTemplateDefinition = {
	id: "integrated",
	sectionIds: SYSTEM_SECTION_IDS,
}

export class SystemTemplateRegistry {
	private readonly templates: ReadonlyMap<string, SystemTemplateDefinition>

	public constructor(templates: readonly SystemTemplateDefinition[]) {
		this.templates = new Map(templates.map((template) => [template.id, template]))
	}

	public get(templateId: string): SystemTemplateDefinition {
		const template = this.templates.get(templateId)
		if (!template) {
			throw new Error(`Unknown system template: ${templateId}`)
		}
		return template
	}
}

/** Frame a system section with a standard Markdown heading. */
export function frameSystemSection(sectionId: string, body: string): string {
	if (sectionId === "agent-role" || body.startsWith("#")) {
		return body
	}
	return body.replace(/^([^\r\n]+)(\r?\n|$)/, "# $1$2")
}

export function assembleSystemSections(
	sectionIds: readonly string[],
	sections: ReadonlyMap<string, string>,
	separator: string,
): string {
	return sectionIds
		.map((sectionId) => frameSystemSection(sectionId, sections.get(sectionId) ?? ""))
		.filter((body) => body.length > 0)
		.join(separator)
}
