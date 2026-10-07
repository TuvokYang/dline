import { MoonshotProviderConfig } from "@shared/proto/dline/provider/moonshot"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer, ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface MoonshotProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Moonshot AI provider �?all data from ApiProfile. moonshotVersion stored in providerConfig. */
export const MoonshotProvider = ({ showModelOptions, isPopup, profile, onUpdate }: MoonshotProviderProps) => {
	const { models, defaultModelId } = useProviderModels("moonshot")
	const pc = profile.moonshot ?? MoonshotProviderConfig.create()
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id
	const moonshotVersion = (pc.moonshotVersion as string) || "v1"

	return (
		<div>
			<DropdownContainer className="dropdown-container" style={{ position: "inherit" }}>
				<label htmlFor="moonshot-version">
					<span style={{ fontWeight: 500, marginTop: 5 }}>API Version</span>
				</label>
				<VSCodeDropdown
					id="moonshot-version"
					onChange={(e: any) => onUpdate({ moonshot: { ...pc, moonshotVersion: e.target.value } })}
					style={{ minWidth: 130, position: "relative" }}
					value={moonshotVersion}>
					<VSCodeOption value="v1">v1</VSCodeOption>
				</VSCodeDropdown>
			</DropdownContainer>
			<ApiKeyField
				initialValue={profile.apiKey}
				onChange={(v) => onUpdate({ apiKey: v })}
				providerName="Moonshot"
				signupUrl="https://platform.moonshot.cn/console/api-keys"
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
