import { ClaudeCodeProviderConfig } from "@shared/proto/dline/provider/claude_code"
import { canDisableClaudeAdaptiveThinking, isClaudeAdaptiveThinkingEnabledByDefault } from "@shared/utils/reasoning-support"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ThinkingControl from "../ThinkingControl"
import { ANTHROPIC_THINKING_DISPLAY_DESCRIPTION, ANTHROPIC_THINKING_DISPLAY_SELECTOR_OPTIONS } from "./anthropicThinkingDisplay"
import { ClaudeCodeOAuthControl } from "./ClaudeCodeOAuthControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface ClaudeCodeProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * Claude Code provider settings.
 *
 * Claude Code is a subscription, so this panel owns an OAuth session rather
 * than an API key or a local CLI path.
 */
export const ClaudeCodeProvider = ({ showModelOptions, isPopup, profile, onUpdate }: ClaudeCodeProviderProps) => {
	const {
		models: claudeCodeModels,
		defaultModelId: claudeCodeDefaultModelId,
		modelInfoSaneDefaults: claudeCodeModelInfoSaneDefaults,
	} = useProviderModels("claude-code")

	const pc = profile.claudeCode ?? ClaudeCodeProviderConfig.create()
	const modelId = profile.modelId || claudeCodeDefaultModelId
	const modelInfo =
		profile.modelInfo ?? (profile.modelId ? claudeCodeModels[profile.modelId] : undefined) ?? claudeCodeModelInfoSaneDefaults

	// The request shape follows the model's declared thinking mode: an adaptive
	// model takes an effort level and rejects a token budget, and the reverse
	// holds for a budget model. Reading the mode keeps this panel from offering
	// a control whose value the request would have to discard.
	const thinking = modelInfo?.capabilities?.thinking
	const effortOptions = thinking?.effortLevels ?? []
	const adaptiveThinkingSupported = thinking?.supported === true && thinking.mode === "effort" && effortOptions.length > 0
	const budgetThinkingSupported = thinking?.mode === "budget" && thinking.maxBudget !== undefined

	return (
		<div>
			<ClaudeCodeOAuthControl profileId={profile.id} />

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={claudeCodeModels}
						onChange={(e) => {
							const v = (e.target as HTMLSelectElement).value
							onUpdate({ modelId: v, modelInfo: claudeCodeModels[v] })
						}}
						selectedModelId={modelId}
					/>
					{/* Driven by catalog metadata rather than a model ID list, which
					    went stale as soon as the catalog changed. Both branches
					    offer the display choice, because it belongs to the thinking
					    block itself rather than to one of the two modes. */}
					{(adaptiveThinkingSupported || budgetThinkingSupported) && (
						<ThinkingControl
							defaultEffort={adaptiveThinkingSupported ? "high" : undefined}
							defaultEnabled={adaptiveThinkingSupported && isClaudeAdaptiveThinkingEnabledByDefault(modelId)}
							disableSupported={canDisableClaudeAdaptiveThinking(modelId)}
							displayDescription={ANTHROPIC_THINKING_DISPLAY_DESCRIPTION}
							displayLabel="Thinking Display"
							displayOptions={ANTHROPIC_THINKING_DISPLAY_SELECTOR_OPTIONS}
							effortDescription={
								canDisableClaudeAdaptiveThinking(modelId)
									? "Use None to disable adaptive thinking. Higher effort increases response detail and token usage."
									: "Adaptive thinking is always enabled for this model. Higher effort increases response detail and token usage."
							}
							effortLabel="Adaptive Thinking"
							effortOptions={effortOptions}
							maxBudget={thinking?.maxBudget}
							mode={adaptiveThinkingSupported ? "effort-only" : "budget-only"}
							onReasoningConfigUpdate={(reasoning) => onUpdate({ claudeCode: { ...pc, reasoning } })}
							reasoningConfig={pc.reasoning}
							showModeSelector={false}
						/>
					)}
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
