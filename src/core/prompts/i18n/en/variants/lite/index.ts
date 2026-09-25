import { createRuntimeContract } from "../../../helpers/create-contract"
import { definePromptModule } from "../../../helpers/define-module"
import {
	LITE_ACT_PLAN,
	LITE_ACT_PLAN_YOLO_ASK_TOOL,
	LITE_ACT_PLAN_YOLO_QUESTION_GUIDANCE,
	LITE_ACT_PLAN_YOLO_REPLACEMENT,
	LITE_AGENT_ROLE,
	LITE_CAPABILITIES,
	LITE_CAPABILITIES_YOLO_QUESTION_GUIDANCE,
	LITE_EDITING_FILES,
	LITE_RULES,
	LITE_RULES_YOLO_ASK_CLAUSE,
	LITE_SUBAGENTS_GUIDANCE,
	LITE_TOOLS_NATIVE,
	LITE_TOOLS_XML,
} from "./content"
export const litePromptModule = definePromptModule({
	name: "variants.lite",
	domain: "variants",
	prompts: {
		actVsPlan: LITE_ACT_PLAN,
		actVsPlanYoloAskTool: LITE_ACT_PLAN_YOLO_ASK_TOOL,
		actVsPlanYoloQuestionGuidance: LITE_ACT_PLAN_YOLO_QUESTION_GUIDANCE,
		actVsPlanYoloReplacement: LITE_ACT_PLAN_YOLO_REPLACEMENT,
		agentRole: LITE_AGENT_ROLE,
		capabilities: LITE_CAPABILITIES,
		capabilitiesYoloQuestionGuidance: LITE_CAPABILITIES_YOLO_QUESTION_GUIDANCE,
		editingFiles: LITE_EDITING_FILES,
		rules: LITE_RULES,
		rulesYoloAskClause: LITE_RULES_YOLO_ASK_CLAUSE,
		subagentsGuidance: LITE_SUBAGENTS_GUIDANCE,
		toolsNative: LITE_TOOLS_NATIVE,
		toolsXml: LITE_TOOLS_XML,
	},
	contracts: {
		rules: createRuntimeContract("WORKSPACE_PATH_RULE"),
		toolsNative: createRuntimeContract("SUBAGENTS_GUIDANCE"),
		toolsXml: createRuntimeContract("XML_TOOLS_SECTION"),
	},
	source: "i18n/en/variants/lite/index.ts",
})
