import { ZAiProviderConfig } from "@shared/proto/dline/provider/zai"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
// Mode import removed — no longer needed in profile-driven architecture
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer, ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface ZAiProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Z AI provider �?all data from ApiProfile. zaiApiLine stored in providerConfig. */
export const ZAiProvider = ({ showModelOptions, isPopup, profile, onUpdate }: ZAiProviderProps) => {
	const pc = profile.zai ?? ZAiProviderConfig.create()
	const zaiApiLine = pc.zaiApiLine || "international"

	const { models: zaiModels, defaultModelId: zaiDefaultModelId } = useProviderModels("zai-intl")
	const modelInfo = resolveProfileModelInfo(profile, { models: zaiModels, defaultModelId: zaiDefaultModelId })
	const modelId = modelInfo.id

	return (
		<div>
			<DropdownContainer className="dropdown-container" style={{ position: "inherit" }}>
				<label htmlFor="zai-entrypoint">
					<span style={{ fontWeight: 500, marginTop: 5 }}>Z AI Entrypoint</span>
				</label>
				<VSCodeDropdown
					id="zai-entrypoint"
					onChange={(e) => onUpdate({ zai: { ...pc, zaiApiLine: (e.target as HTMLSelectElement).value } })}
					style={{ minWidth: 130, position: "relative" }}
					value={zaiApiLine}>
					<VSCodeOption value="international">api.z.ai</VSCodeOption>
					<VSCodeOption value="china">open.bigmodel.cn</VSCodeOption>
				</VSCodeDropdown>
			</DropdownContainer>
			<p style={{ fontSize: "12px", marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
				Please select the appropriate API entrypoint based on your location.
			</p>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="Z AI"
				signupUrl={
					zaiApiLine === "china"
						? "https://open.bigmodel.cn/console/overview"
						: "https://z.ai/manage-apikey/apikey-list"
				}
			/>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={zaiModels}
						onChange={(e) => {
							const v = (e.target as HTMLSelectElement).value
							onUpdate({ modelId: v, modelInfo: zaiModels[v] })
						}}
						selectedModelId={modelId}
					/>
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
