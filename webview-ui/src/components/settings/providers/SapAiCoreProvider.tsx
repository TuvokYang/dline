import { SapAiCoreProviderConfig } from "@shared/proto/dline/provider/sapaicore"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
// Mode import removed — no longer needed in profile-driven architecture
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface SapAiCoreProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

export const SapAiCoreProvider = ({ showModelOptions, isPopup, profile, onUpdate }: SapAiCoreProviderProps) => {
	const pc = profile.sapaicore ?? SapAiCoreProviderConfig.create()
	const { models, defaultModelId } = useProviderModels("sapaicore")
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id

	const persistConfig = (key: string, value: string) => onUpdate({ sapaicore: { ...pc, [key]: value } })

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
			<DebouncedTextField
				initialValue={profile.baseUrl || ""}
				onChange={(value) => onUpdate({ baseUrl: value || undefined })}
				placeholder="https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com/v2"
				style={{ width: "100%" }}>
				<span style={{ fontWeight: 500 }}>Base URL</span>
			</DebouncedTextField>

			<DebouncedTextField
				ariaLabel="Client ID"
				initialValue={(pc.clientId as string) ?? ""}
				onChange={(value) => persistConfig("clientId", value)}
				placeholder="Enter Client ID"
				style={{ width: "100%" }}>
				<span style={{ fontWeight: 500 }}>Client ID</span>
			</DebouncedTextField>

			<DebouncedTextField
				ariaLabel="Client Secret"
				initialValue={(pc.clientSecret as string) ?? ""}
				onChange={(value) => persistConfig("clientSecret", value)}
				placeholder="Enter Client Secret"
				style={{ width: "100%" }}
				type="password">
				<span style={{ fontWeight: 500 }}>Client Secret</span>
			</DebouncedTextField>

			<DebouncedTextField
				ariaLabel="Token URL"
				initialValue={(pc.tokenUrl as string) ?? ""}
				onChange={(value) => persistConfig("tokenUrl", value)}
				placeholder="Enter Token URL"
				style={{ width: "100%" }}>
				<span style={{ fontWeight: 500 }}>Token URL</span>
			</DebouncedTextField>

			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(v) => onUpdate({ apiKey: v })}
				providerName="SAP AI Core"
				signupUrl="https://help.sap.com/docs/sap-ai-core/"
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
