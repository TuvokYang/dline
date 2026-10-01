import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface CerebrasProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

export const CerebrasProvider = ({ showModelOptions, isPopup, profile, onUpdate }: CerebrasProviderProps) => {
	const { models, defaultModelId } = useProviderModels("cerebras")
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id
	return (
		<div>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(v) => onUpdate({ apiKey: v })}
				providerName="Cerebras"
				signupUrl="https://cloud.cerebras.ai/"
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
