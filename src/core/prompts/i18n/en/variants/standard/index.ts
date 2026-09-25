import { createRuntimeContract } from "../../../helpers/create-contract"
import { definePromptModule } from "../../../helpers/define-module"
import {
	STANDARD_ACT_VS_PLAN,
	STANDARD_PARALLEL_TOOL_USE,
	STANDARD_RULES,
	STANDARD_RULES_FOCUS_CONTRACT,
	STANDARD_TOOL_USE_PREFIX,
	STANDARD_TOOL_USE_SUFFIX,
} from "./content"
export const standardPromptModule = definePromptModule({
	name: "variants.standard",
	domain: "variants",
	prompts: {
		actVsPlan: STANDARD_ACT_VS_PLAN,
		parallelToolUse: STANDARD_PARALLEL_TOOL_USE,
		rules: STANDARD_RULES,
		rulesFocusContract: STANDARD_RULES_FOCUS_CONTRACT,
		toolUsePrefix: STANDARD_TOOL_USE_PREFIX,
		toolUseSuffix: STANDARD_TOOL_USE_SUFFIX,
	},
	contracts: {
		actVsPlan: createRuntimeContract("CLARIFY_PERMISSION"),
		rules: createRuntimeContract("WORKSPACE_PATH_RULE", "PARALLEL_TOOLS_RULE", "BROWSER_WAIT_RULES", "MCP_RULE"),
	},
	source: "i18n/en/variants/standard/index.ts",
})
