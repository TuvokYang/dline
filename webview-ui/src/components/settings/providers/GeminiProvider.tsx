import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ThinkingControl from "../ThinkingControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

/**
 * Props for the GeminiProvider component
 */
interface GeminiProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The Gemini provider configuration component.
 * All data sourced from ApiProfile.
 */
export const GeminiProvider = ({ showModelOptions, isPopup, profile, onUpdate }: GeminiProviderProps) => {
	const { models: geminiModels, defaultModelId: geminiDefaultModelId } = useProviderModels("gemini")
	const pc = profile.gemini ?? BaseProviderConfig.create()
	const modelInfo = resolveProfileModelInfo(profile, { models: geminiModels, defaultModelId: geminiDefaultModelId })
	const modelId = modelInfo.id
	const thinking = modelInfo.capabilities?.thinking
	const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
	const effortSupported = thinkingSupported && thinking?.mode === "effort"
	const budgetSupported = thinkingSupported && thinking?.mode === "budget"

	return (
		<div>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="Gemini"
				signupUrl="https://aistudio.google.com/apikey"
			/>

			<BaseUrlField
				initialValue={profile.baseUrl}
				label="Use custom base URL"
				onChange={(value) => onUpdate({ baseUrl: value || undefined })}
				placeholder="Default: https://generativelanguage.googleapis.com"
			/>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={geminiModels}
						onChange={(e) =>
							onUpdate({
								modelId: (e.target as HTMLSelectElement).value,
								modelInfo: geminiModels[(e.target as HTMLSelectElement).value],
							})
						}
						selectedModelId={modelId}
					/>

					{(effortSupported || budgetSupported) && (
						<ThinkingControl
							defaultEffort={thinking?.defaultEffort}
							defaultEnabled={thinking?.defaultEnabled}
							disableSupported={thinking?.canDisable !== false}
							effortOptions={thinking?.effortLevels ?? []}
							maxBudget={thinking?.maxBudget}
							mode={effortSupported ? "effort-only" : "budget-only"}
							onReasoningConfigUpdate={(reasoning) => onUpdate({ gemini: { ...pc, reasoning } })}
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
