// English skills prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	catalogGuidance:
		'Skills provide task-specific methods, constraints, and best practices so work follows a proven domain approach instead of generic reasoning. Every project has its own operating rules and procedures, and a Skill records them for this project; general capability is not a substitute. Stay humble: when the request matches an advertised description, use `load_skill` once with the exact name before doing that work, even if the task looks familiar or you believe you could complete it without the Skill, then follow the returned instructions directly for the current task. If `<explicit_instructions type="skill">` is already present, follow those instructions directly and do not call `load_skill` again. A Skill is strong guidance, not infallible: when a step appears outdated or conflicts with current project evidence, report the specific step and the evidence to the user, and modify the Skill only after the user authorizes the change.',
	catalogListIntroduction: "The Skills available to the current task are listed below:",
}

export default prompts
