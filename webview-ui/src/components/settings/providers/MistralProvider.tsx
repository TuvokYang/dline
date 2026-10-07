// Mode import removed — no longer needed in profile-driven architecture
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

/**
 * Props for the MistralProvider component
 */
interface MistralProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The Mistral provider configuration component.
 * All data sourced from ApiProfile.
 */
export const MistralProvider = ({ showModelOptions, isPopup: _isPopup, profile, onUpdate }: MistralProviderProps) => {
	const { models: mistralModels, defaultModelId: mistralDefaultModelId } = useProviderModels("mistral")

	const modelInfo = resolveProfileModelInfo(profile, { models: mistralModels, defaultModelId: mistralDefaultModelId })
	const modelId = modelInfo.id

	return (
		<div>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="Mistral"
				signupUrl="https://console.mistral.ai/codestral"
			/>

			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={mistralModels}
						onChange={(e: any) =>
							onUpdate({ modelId: e.target.value, modelInfo: mistralModels[e.target.value] as any })
						}
						selectedModelId={modelId}
					/>

					<ModelInfoView isPopup={_isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
