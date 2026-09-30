import { VertexProviderConfig } from "@shared/proto/dline/provider/vertex"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import VertexData from "@shared/providers/vertex.json"
import { VSCodeDropdown, VSCodeLink, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { DROPDOWN_Z_INDEX, DropdownContainer } from "../ApiOptions"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { LockIcon, RemotelyConfiguredInputWrapper } from "../common/RemotelyConfiguredInputWrapper"
import ThinkingControl from "../ThinkingControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

const REGIONS = VertexData.regions

interface VertexProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/** GCP Vertex AI provider �?all data from ApiProfile. vertexProjectId/vertexRegion stored in providerConfig. */
export const VertexProvider = ({ showModelOptions, isPopup, profile, onUpdate }: VertexProviderProps) => {
	const { remoteConfigSettings } = useExtensionState()
	const remote = remoteConfigSettings as any
	const pc = profile.vertex ?? VertexProviderConfig.create()
	const vertexProjectId = pc.vertexProjectId ?? ""
	const vertexRegion = pc.vertexRegion ?? ""

	const { models, defaultModelId } = useProviderModels("vertex")
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id
	const thinking = modelInfo.capabilities?.thinking
	const thinkingSupported = thinking?.supported === true && modelInfo.capabilities?.supportsReasoning !== false
	const effortSupported = thinkingSupported && thinking?.mode === "effort"
	const budgetSupported = thinkingSupported && thinking?.mode === "budget"
	const persistConfig = (key: string, value: string) => onUpdate({ vertex: { ...pc, [key]: value } })

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
			<RemotelyConfiguredInputWrapper hidden={remote?.vertexProjectId === undefined}>
				<DebouncedTextField
					disabled={remote?.vertexProjectId !== undefined}
					initialValue={vertexProjectId}
					onChange={(value) => persistConfig("vertexProjectId", value)}
					placeholder="Enter Project ID..."
					style={{ width: "100%" }}>
					<div className="flex items-center gap-2 mb-1">
						<span style={{ fontWeight: 500 }}>Google Cloud Project ID</span>
						{remote?.vertexProjectId !== undefined && <LockIcon />}
					</div>
				</DebouncedTextField>
			</RemotelyConfiguredInputWrapper>
			<RemotelyConfiguredInputWrapper hidden={remote?.vertexRegion === undefined}>
				<DropdownContainer className="dropdown-container" zIndex={DROPDOWN_Z_INDEX - 1}>
					<div
						className="flex items-center gap-2 mb-1"
						style={{ opacity: remote?.vertexRegion !== undefined ? 0.4 : 1 }}>
						<label htmlFor="vertex-region-dropdown">
							<span className="font-medium">Google Cloud Region</span>
						</label>
						{remote?.vertexRegion !== undefined && <LockIcon />}
					</div>
					<VSCodeDropdown
						disabled={remote?.vertexRegion !== undefined}
						id="vertex-region-dropdown"
						onChange={(e: any) => persistConfig("vertexRegion", e.target.value)}
						style={{ width: "100%" }}
						value={vertexRegion}>
						<VSCodeOption value="">Select a region...</VSCodeOption>
						{REGIONS.map((r) => (
							<VSCodeOption key={r} value={r}>
								{r}
							</VSCodeOption>
						))}
					</VSCodeDropdown>
				</DropdownContainer>
			</RemotelyConfiguredInputWrapper>
			<p style={{ fontSize: "12px", marginTop: "5px", color: "var(--vscode-descriptionForeground)" }}>
				To use Google Cloud Vertex AI, you need to{" "}
				<VSCodeLink
					href="https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#before_you_begin"
					style={{ display: "inline", fontSize: "inherit" }}>
					{"1) create a Google Cloud account �?enable the Vertex AI API �?enable the desired Claude models,"}
				</VSCodeLink>{" "}
				<VSCodeLink
					href="https://cloud.google.com/docs/authentication/provide-credentials-adc#google-idp"
					style={{ display: "inline", fontSize: "inherit" }}>
					{"2) install the Google Cloud CLI �?configure Application Default Credentials."}
				</VSCodeLink>
			</p>
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
						zIndex={DROPDOWN_Z_INDEX - 2}
					/>
					{(effortSupported || budgetSupported) && (
						<ThinkingControl
							defaultEffort={thinking?.defaultEffort}
							defaultEnabled={thinking?.defaultEnabled}
							disableSupported={thinking?.canDisable !== false}
							effortOptions={thinking?.effortLevels ?? []}
							maxBudget={thinking?.maxBudget}
							mode={effortSupported ? "effort-only" : "budget-only"}
							onReasoningConfigUpdate={(reasoning) => onUpdate({ vertex: { ...pc, reasoning } })}
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
