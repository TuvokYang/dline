// Mode import removed — no longer needed in profile-driven architecture
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface GroqProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

export const GroqProvider = ({ showModelOptions, isPopup, profile, onUpdate }: GroqProviderProps) => {
	const { models, defaultModelId } = useProviderModels("groq")
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id
	return (
		<div>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(v) => onUpdate({ apiKey: v })}
				providerName="Groq"
				signupUrl="https://console.groq.com/keys"
			/>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={models}
						onChange={(e) =>
							onUpdate({
								modelId: (e.target as HTMLSelectElement).value,
								modelInfo: models[(e.target as HTMLSelectElement).value],
							})
						}
						selectedModelId={modelId}
					/>
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
