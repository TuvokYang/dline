import { getPrompt } from "../../i18n"
import { createLiteActVsPlan, createStandardActVsPlan } from "./act-vs-plan-content"
import { createLiteObjective, createStandardObjective } from "./objective-content"
import type { SystemSectionContentConfig } from "./section-content-config"
import type { SystemSectionSet } from "./section-preparation"
import { createLiteSectionSet, createStandardSectionSet } from "./section-preparation"
import { createLiteToolUse, createStandardToolUse } from "./tool-use-content"

export type { SystemSectionContentConfig } from "./section-content-config"

const STANDARD_AGENT_ROLE = getPrompt("agentRole", "main")
const SHARED_USER_AUTHORITY = getPrompt("userAuthority", "main")
const SHARED_USER_COMMUNICATION = getPrompt("userCommunication", "main")
const STANDARD_CAPABILITIES = getPrompt("capabilitiesCore", "main")
const LITE_CAPABILITIES = getPrompt("capabilitiesCore", "lite")
const STANDARD_EXECUTION = getPrompt("execution", "standard")
const LITE_EXECUTION = getPrompt("execution", "lite")
const SHARED_SYSTEM_INFO = getPrompt("systemInfo", "main")
const SHARED_FEEDBACK = getPrompt("feedback", "main")
const SHARED_USER_INSTRUCTIONS = getPrompt("userInstructions", "main")
const SHARED_TASK_PROGRESS = getPrompt("taskProgress", "standardFused")
const LITE_AGENT_ROLE = getPrompt("variants.lite", "agentRole")

export function createStandardSystemSections(config: SystemSectionContentConfig): SystemSectionSet {
	return createStandardSectionSet({
		"agent-role": STANDARD_AGENT_ROLE,
		"user-authority": SHARED_USER_AUTHORITY,
		objective: createStandardObjective(config),
		"act-vs-plan": createStandardActVsPlan(),
		"user-communication": SHARED_USER_COMMUNICATION,
		"tool-use": createStandardToolUse(config),
		"task-progress": config.focusChainEnabled ? SHARED_TASK_PROGRESS : "",
		capabilities: STANDARD_CAPABILITIES,
		execution: STANDARD_EXECUTION,
		"system-info": SHARED_SYSTEM_INFO,
		feedback: SHARED_FEEDBACK,
		"user-instructions": config.userInstructionsEnabled ? SHARED_USER_INSTRUCTIONS : "",
	})
}

export function createLiteSystemSections(config: SystemSectionContentConfig): SystemSectionSet {
	return createLiteSectionSet({
		"agent-role": LITE_AGENT_ROLE,
		"user-authority": SHARED_USER_AUTHORITY,
		objective: createLiteObjective(),
		"act-vs-plan": createLiteActVsPlan(config),
		"user-communication": SHARED_USER_COMMUNICATION,
		"tool-use": createLiteToolUse(config),
		capabilities: LITE_CAPABILITIES,
		execution: LITE_EXECUTION,
		"system-info": SHARED_SYSTEM_INFO,
		feedback: SHARED_FEEDBACK,
		"user-instructions": config.userInstructionsEnabled ? SHARED_USER_INSTRUCTIONS : "",
	})
}
