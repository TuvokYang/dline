import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { resolveApiFormat } from "@shared/providers/api-format"
import { resolveProfileModelId, resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useRef, useState } from "react"
import { ApiFormatSelector } from "../common/ApiFormatSelector"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { resolveDeepSeekThinkingPreference } from "./deepseek-thinking"
import type { ApiProfile } from "./ProviderProfile"
import { ProviderWebToolsSettings } from "./ProviderWebToolsSettings"
import { useProviderModelOptions } from "./useProviderModelOptions"

/**
 * Props for the DeepSeekProvider component
 */
interface DeepSeekProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The DeepSeek provider configuration component.
 * All data sourced from ApiProfile.
 * Reasoning effort stored in deepseek.
 */
export const DeepSeekProvider = ({ showModelOptions, isPopup, profile, onUpdate }: DeepSeekProviderProps) => {
	const {
		models: deepSeekModels,
		defaultModelId: deepSeekDefaultModelId,
		options: deepSeekModelOptions,
		optionOrigins,
		refreshRemoteModels,
	} = useProviderModelOptions({
		providerId: "deepseek",
		profileId: profile.id,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		selectedModelId: resolveProfileModelId(profile),
	})

	const modelId = resolveProfileModelId(profile, { defaultModelId: deepSeekDefaultModelId })
	const pc = profile.deepseek ?? BaseProviderConfig.create()
	const modelInfo: ModelInfo = resolveProfileModelInfo(profile, {
		models: deepSeekModels,
		defaultModelId: deepSeekDefaultModelId,
	})
	const selectedApiFormat = resolveApiFormat(pc.apiFormat, modelInfo, ApiFormat.OPENAI_CHAT)
	const hostedWebSearchAvailable =
		modelInfo.capabilities?.tools?.includes(ServerTool.WEB_SEARCH) === true &&
		(selectedApiFormat === ApiFormat.OPENAI_RESPONSES || selectedApiFormat === ApiFormat.ANTHROPIC_CHAT)

	const reasoningConfig = profile.deepseek?.reasoning
	const thinking = modelInfo.capabilities?.thinking
	const thinkingPreference = resolveDeepSeekThinkingPreference(
		reasoningConfig,
		thinking,
		modelInfo.capabilities?.supportsReasoning,
	)
	const { supported: supportsThinking, effortLevels, profileEffort, defaultEffort } = thinkingPreference
	const configuredEnabled = thinkingPreference.enabled
	const [enableThinking, setEnableThinking] = useState(configuredEnabled)
	const savedEffortRef = useRef<string>(effortLevels.includes(profileEffort) ? profileEffort : defaultEffort)

	useEffect(() => {
		setEnableThinking(configuredEnabled)
	}, [configuredEnabled])

	const persistReasoning = (reasoning: ReasoningConfig) => {
		const base = profile.deepseek ?? BaseProviderConfig.create()
		onUpdate({
			deepseek: {
				...base,
				reasoning,
			},
		})
	}

	const persistEffort = (value: string) => {
		if (!effortLevels.includes(value)) return
		savedEffortRef.current = value
		persistReasoning({
			enableThinking: value !== "none",
			effort: value,
		})
	}

	return (
		<div>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(value) => onUpdate({ apiKey: value })}
				providerName="DeepSeek"
				signupUrl="https://www.deepseek.com/"
			/>

			{showModelOptions && (
				<>
					<ModelAutocomplete
						label="Model"
						models={deepSeekModelOptions}
						onChange={(newModelId) => {
							// Only catalog entries carry metadata; a discovered id keeps
							// the profile's existing model info untouched.
							const nextModel = deepSeekModels[newModelId]
							onUpdate({
								modelId: newModelId,
								...(nextModel ? { modelInfo: nextModel } : {}),
								deepseek: {
									...pc,
									apiFormat: resolveApiFormat(pc.apiFormat, nextModel, ApiFormat.OPENAI_CHAT),
								},
							})
						}}
						onOpen={refreshRemoteModels}
						optionOrigins={optionOrigins}
						placeholder="Search, select, or enter a model ID..."
						selectedModelId={modelId}
					/>

					<ApiFormatSelector
						apiFormats={modelInfo?.apiFormats}
						fallbackApiFormat={ApiFormat.OPENAI_CHAT}
						onChange={(apiFormat) => onUpdate({ deepseek: { ...pc, apiFormat } })}
						selectedApiFormat={selectedApiFormat}
					/>

					<ProviderWebToolsSettings
						hostedAvailable={hostedWebSearchAvailable}
						onChange={(webToolsMode) => onUpdate({ webToolsMode })}
						value={profile.webToolsMode}
					/>

					{supportsThinking ? (
						<>
							<div style={{ marginTop: 8 }}>
								<VSCodeCheckbox
									checked={enableThinking}
									disabled={thinking?.canDisable === false}
									onChange={(event) => {
										const target = event.target as (EventTarget & { checked?: boolean }) | null
										const checked = target?.checked === true
										if (!checked && thinking?.canDisable === false) return
										const prevEffort = effortLevels.includes(profileEffort)
											? profileEffort
											: effortLevels.includes(savedEffortRef.current)
												? savedEffortRef.current
												: defaultEffort
										setEnableThinking(checked)
										if (checked) {
											savedEffortRef.current = prevEffort
											persistReasoning({
												enableThinking: true,
												...(prevEffort ? { effort: prevEffort } : {}),
											})
										} else {
											persistReasoning({ enableThinking: false })
										}
									}}>
									Enable Thinking
								</VSCodeCheckbox>
							</div>
							{enableThinking && (
								<ReasoningEffortSelector
									allowedEfforts={effortLevels}
									defaultEffort={defaultEffort}
									description="Toggle above to enable thinking. Low uses less reasoning; High is the standard level; Max is for complex tasks."
									label="Thinking Level"
									onReasoningEffortChange={persistEffort}
									reasoningEffort={profileEffort}
								/>
							)}
						</>
					) : null}

					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
