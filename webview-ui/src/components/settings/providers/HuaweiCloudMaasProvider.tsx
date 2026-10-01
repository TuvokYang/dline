// Mode import removed — no longer needed in profile-driven architecture
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface HuaweiCloudMaasProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

export const HuaweiCloudMaasProvider = ({ showModelOptions, isPopup, profile, onUpdate }: HuaweiCloudMaasProviderProps) => {
	const { models, defaultModelId } = useProviderModels("huawei-cloud-maas")
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id
	return (
		<div>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(v) => onUpdate({ apiKey: v })}
				providerName="Huawei Cloud MaaS"
				signupUrl="https://support.huaweicloud.com/intl/zh-cn/usermanual-maas/maas_01_0001.html"
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
