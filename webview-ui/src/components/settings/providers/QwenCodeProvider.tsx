import { QwenCodeProviderConfig } from "@shared/proto/dline/provider/qwen_code"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

interface QwenCodeProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Qwen Code provider â€?all data from ApiProfile. qwenCodeOauthPath stored in providerConfig. */
export const QwenCodeProvider = ({ showModelOptions, isPopup, profile, onUpdate }: QwenCodeProviderProps) => {
	const { models, defaultModelId } = useProviderModels("qwen-code")
	const pc = profile.qwenCode ?? QwenCodeProviderConfig.create()
	const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })
	const modelId = modelInfo.id

	return (
		<div>
			<h3 style={{ color: "var(--vscode-foreground)", margin: "8px 0" }}>Qwen Code API Configuration</h3>
			<VSCodeTextField
				onInput={(e: any) => onUpdate({ qwenCode: { ...pc, qwenCodeOauthPath: e.target.value } })}
				placeholder="~/.qwen/oauth_creds.json"
				style={{ width: "100%" }}
				value={pc.qwenCodeOauthPath ?? ""}>
				OAuth Credentials Path
			</VSCodeTextField>
			<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "4px" }}>
				Path to your Qwen OAuth credentials file.
			</div>
			<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "12px" }}>
				Qwen Code is an OAuth-based API. You'll need to set up OAuth credentials first.
			</div>
			<div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "8px" }}>
				To get started:
				<br />
				1. Install the official Qwen client
				<br />
				2. Authenticate
				<br />
				3. OAuth credentials stored automatically
			</div>
			<VSCodeLink
				href="https://github.com/QwenLM/qwen-code/blob/main/README.md"
				style={{
					color: "var(--vscode-textLink-foreground)",
					marginTop: "8px",
					display: "inline-block",
					fontSize: "12px",
				}}>
				Setup Instructions
			</VSCodeLink>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={models}
						onChange={(e) => {
							const v = (e.target as HTMLSelectElement).value
							onUpdate({ modelId: v, modelInfo: models[v] })
						}}
						selectedModelId={modelId}
					/>
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
				</>
			)}
		</div>
	)
}
