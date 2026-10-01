import { QwenApiRegions } from "@shared/api"
import { QwenProviderConfig } from "@shared/proto/dline/provider/qwen"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { DROPDOWN_Z_INDEX } from "../ApiOptions"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer, ModelSelector } from "../common/ModelSelector"
import ThinkingControl from "../ThinkingControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface QwenProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

export const qwenApiOptions: QwenApiRegions[] = Object.values(QwenApiRegions)

/** Alibaba Qwen provider all data from ApiProfile. qwenApiLine stored in qwen. */
export const QwenProvider = ({ showModelOptions, isPopup: _isPopup, profile, onUpdate }: QwenProviderProps) => {
	const pc = profile.qwen ?? QwenProviderConfig.create()
	const qwenApiLine = (pc.qwenApiLine as QwenApiRegions) || qwenApiOptions[0]

	const { models: qwenModels, defaultModelId: qwenDefaultModelId } = useProviderModels("qwen")
	const modelId = profile.modelId || qwenDefaultModelId
	const baseModel = profile.modelInfo?.id === modelId ? profile.modelInfo : qwenModels[modelId]
	const modelInfo = buildEffectiveModelInfo(modelId, baseModel, { capabilities: pc.capabilities, pricing: pc.pricing })
	const thinking = modelInfo.capabilities?.thinking
	const budgetSupported =
		thinking?.supported === true && thinking.mode === "budget" && modelInfo.capabilities?.supportsReasoning !== false

	return (
		<div>
			<DropdownContainer className="dropdown-container" style={{ position: "inherit" }}>
				<label htmlFor="qwen-line-provider">
					<span style={{ fontWeight: 500, marginTop: 5 }}>Alibaba API Line</span>
				</label>
				<VSCodeDropdown
					id="qwen-line-provider"
					onChange={(e) => onUpdate({ qwen: { ...pc, qwenApiLine: (e.target as HTMLSelectElement).value || "" } })}
					style={{ minWidth: 130, position: "relative" }}
					value={qwenApiLine}>
					{qwenApiOptions.map((line) => (
						<VSCodeOption key={line} value={line}>
							{line.charAt(0).toUpperCase() + line.slice(1)} API
						</VSCodeOption>
					))}
				</VSCodeDropdown>
			</DropdownContainer>
			<p style={{ fontSize: "12px", marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
				Please select the appropriate API interface based on your location.
			</p>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="Qwen"
				signupUrl="https://bailian.console.aliyun.com/"
			/>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={qwenModels}
						onChange={(e) => {
							const v = (e.target as HTMLSelectElement).value
							onUpdate({ modelId: v || "", modelInfo: qwenModels[v || ""] })
						}}
						selectedModelId={modelId}
						zIndex={DROPDOWN_Z_INDEX - 2}
					/>
					{budgetSupported && (
						<ThinkingControl
							defaultEnabled={thinking?.defaultEnabled}
							disableSupported={thinking?.canDisable !== false}
							maxBudget={thinking?.maxBudget}
							minBudget={thinking?.minBudget}
							mode="budget-only"
							onReasoningConfigUpdate={(reasoning) => onUpdate({ qwen: { ...pc, reasoning } })}
							reasoningConfig={pc.reasoning}
							showModeSelector={false}
						/>
					)}
					<ModelInfoView isPopup={_isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
