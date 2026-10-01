// Mode import removed — no longer needed in profile-driven architecture
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { useEffect, useState } from "react"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface AskSageProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/** AskSage provider �?all data from ApiProfile. baseUrl used for API URL. */
export const AskSageProvider = ({ showModelOptions, isPopup, profile, onUpdate }: AskSageProviderProps) => {
	const { models: askSageModels, defaultModelId: asksageDefaultModelId } = useProviderModels("asksage")

	const baseUrl = profile.baseUrl || "https://api.asksage.ai/server"
	const modelInfo = resolveProfileModelInfo(profile, { models: askSageModels, defaultModelId: asksageDefaultModelId })
	const modelId = modelInfo.id

	const [availableModels, setAvailableModels] = useState(askSageModels)

	useEffect(() => {
		const apiUrl = baseUrl
		fetch(`${apiUrl}/get-models`)
			.then((r) => (r.ok ? r.json() : Promise.reject()))
			.then((data) => {
				const ids: string[] = data?.response ?? []
				if (ids.length > 0) {
					const filtered: Record<string, any> = {}
					ids.forEach((id) => {
						if (askSageModels[id]) filtered[id] = askSageModels[id]
					})
					setAvailableModels(Object.keys(filtered).length > 0 ? filtered : askSageModels)
				}
			})
			.catch(() => setAvailableModels(askSageModels))
	}, [baseUrl, askSageModels])

	return (
		<div>
			<ApiKeyField
				helpText="This key is stored locally and only used to make API requests from this extension."
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="AskSage"
			/>
			<DebouncedTextField
				initialValue={baseUrl}
				onChange={(value) => onUpdate({ baseUrl: value })}
				placeholder="Enter AskSage API URL..."
				style={{ width: "100%" }}
				type="text">
				<span style={{ fontWeight: 500 }}>AskSage API URL</span>
			</DebouncedTextField>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={availableModels}
						onChange={(e: any) =>
							onUpdate({ modelId: e.target.value, modelInfo: availableModels[e.target.value] as any })
						}
						selectedModelId={modelId}
					/>
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
