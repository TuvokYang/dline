import { RuntimePromptGenerator } from "./generators/RuntimePromptGenerator"
import { englishTemplateStore } from "./i18n/en"

const runtimeGenerator = new RuntimePromptGenerator(englishTemplateStore)

export const summarizeTask = (
	focusChainSettings?: { enabled: boolean },
	_cwd?: string,
	_isMultiRootEnabled?: boolean,
	compactionWindowBudget = "",
) => {
	const WORKSPACE_PATH_RULE = runtimeGenerator.generate("runtimeEnvironment.workspacePathRule", {}).text

	const focusChainEnabled = focusChainSettings?.enabled
	const focusChainParam = focusChainEnabled
		? runtimeGenerator.generate("contextManagement.summarizeFocusChainParam", {}).text
		: ""
	const focusChainUsage = focusChainEnabled
		? runtimeGenerator.generate("contextManagement.summarizeFocusChainUsage", {}).text
		: ""
	const focusChainExample = focusChainEnabled
		? runtimeGenerator.generate("contextManagement.summarizeFocusChainExample", {}).text
		: ""
	const summaryDecision = runtimeGenerator.generate(
		focusChainEnabled ? "contextManagement.summarizeDecisionWithFocus" : "contextManagement.summarizeDecisionWithoutFocus",
		{},
	).text

	return `${
		runtimeGenerator.generate("contextManagement.summarizeMain", {
			WORKSPACE_PATH_RULE,
			FOCUS_CHAIN_PARAM: focusChainParam,
			FOCUS_CHAIN_USAGE: focusChainUsage,
			FOCUS_CHAIN_EXAMPLE: focusChainExample,
			SUMMARY_DECISION: summaryDecision,
			COMPACTION_WINDOW_BUDGET: compactionWindowBudget ? `${compactionWindowBudget}\n\n` : "",
		}).text
	}\n`
}

export const continuationPrompt = (summaryText: string) =>
	`${runtimeGenerator.generate("contextManagement.continuationPrompt", { SUMMARY_TEXT: summaryText }).text}\n`
