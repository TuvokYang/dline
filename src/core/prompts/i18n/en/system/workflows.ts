// English workflow prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	standardCatalogGuidance:
		'Workflows provide reusable, ordered procedures for multi-step operations so required stages, checks, and handoffs are followed consistently. Every project has its own operating rules and procedures, and a Workflow records them for this project; general capability is not a substitute. Stay humble: when the request matches an advertised description, use `load_workflow` once with the exact advertised name before starting that work, even if the operation looks familiar or you believe you could complete it without the Workflow, then follow the returned steps in order. If `<explicit_instructions type="workflow">` is already present, follow those instructions directly and do not call `load_workflow` again. A Workflow is strong guidance, not infallible: when a step appears outdated or conflicts with current project evidence, report the specific step and the evidence to the user, and modify the Workflow only after the user authorizes the change.',
	liteCatalogGuidance:
		'Workflows provide reusable, ordered procedures for multi-step operations so required stages, checks, and handoffs are followed consistently. Every project has its own operating rules and procedures, and a Workflow records them for this project. If `<explicit_instructions type="workflow">` is present, follow the provided steps in order instead of substituting your own procedure. A Workflow is strong guidance, not infallible: when a step appears outdated or conflicts with current project evidence, report the specific step and the evidence to the user, and modify the Workflow only after the user authorizes the change.',
	catalogListIntroduction: "The Workflows available to the current task are listed below:",
}

export default prompts
