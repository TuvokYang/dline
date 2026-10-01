import { GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import { ApiFormat, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { type ImageGenerationProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { PROFILE_PROVIDER_KEYS, resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { clampThinkingBudget, resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"
import type { Mode } from "@shared/storage/types"
import { resolveProfileReasoningConfig, resolveTaskThinkingConfig } from "@shared/task-reasoning"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type { ReactNode } from "react"
import { ProfileField, ProfileForm, ProfileSection } from "../profile-ui"
import { formatDeepSeekThinkingSummary } from "./deepseek-thinking"
import { ProfileCapabilityIcons } from "./ProfileCapabilityIcons"
import { ProfileUsageBadges } from "./ProfileUsageBadges"
import type { ApiProfile } from "./ProviderProfile"
import ApiProfileEditor from "./ProviderProfileEditor"
import { getCachedProviderDefaultImageModelId, getCachedProviderDefaultModelId, useProviderModels } from "./useProviderModels"
import { WebToolsModeControl } from "./WebToolsModeControl"

function formatThinkingSummary(reasoning: ReasoningConfig | undefined, thinking: ThinkingConfig | undefined) {
	if (thinking?.supported !== true || (thinking.mode !== "effort" && thinking.mode !== "budget")) return undefined
	const effort = reasoning?.effort?.trim()
	const required = thinking.canDisable === false
	const disabled =
		reasoning?.enableThinking === false ||
		effort === "none" ||
		(thinking.mode === "budget" && reasoning?.thinkingBudget === 0)
	if (disabled && !required) return "Thinking: Off"

	if (thinking.mode === "budget") {
		if (!resolveThinkingBudgetBounds(thinking)) return undefined
		const budget = disabled ? undefined : clampThinkingBudget(reasoning?.thinkingBudget ?? 0, thinking)
		const enabled = required || (reasoning?.enableThinking ?? (budget !== undefined || thinking.defaultEnabled === true))
		if (!enabled) return undefined
		return budget !== undefined ? `Thinking: ${budget.toLocaleString()} tokens` : "Thinking: Budget"
	}

	const levels = thinking.effortLevels ?? []
	const legalEffort = !disabled && effort && levels.includes(effort) ? effort : undefined
	const enabled = required || (reasoning?.enableThinking ?? (legalEffort !== undefined || thinking.defaultEnabled === true))
	if (!enabled) return undefined
	const defaultEffort =
		!disabled && thinking.defaultEffort && levels.includes(thinking.defaultEffort) ? thinking.defaultEffort : undefined
	const selectedEffort = legalEffort ?? defaultEffort
	return selectedEffort ? `Thinking: ${selectedEffort.replace(/^./, (character) => character.toUpperCase())}` : "Thinking: On"
}

interface ApiProfileCardProps {
	profile: ApiProfile
	isExpanded: boolean
	editMode: boolean
	currentMode: Mode
	providerOptions: readonly { value: string; label: string }[]
	imageProfiles: ImageGenerationProfile[]
	imageGenerationEnabled: boolean
	onToggleExpand: () => void
	onDelete: () => void
	onUpdate: (updates: Partial<ApiProfile>) => void
	selected?: boolean
	onToggleSelect?: () => void
	dragHandle?: ReactNode
}

/**
 * Collapsible card. Collapsed shows summary, expanded delegates to ApiProfileEditor.
 */
const ApiProfileCard: React.FC<ApiProfileCardProps> = ({
	profile,
	isExpanded,
	editMode,
	providerOptions,
	imageProfiles = [],
	imageGenerationEnabled,
	onToggleExpand,
	onUpdate,
	selected,
	onToggleSelect,
	dragHandle,
}) => {
	const hasProvider = !!profile.provider
	const providerLabel = hasProvider ? profile.provider : "Select provider..."
	const modelLabel = profile.modelId || (hasProvider ? "Select model..." : "")
	const profileName =
		profile.name || (hasProvider && profile.modelId ? `${profile.provider}:${profile.modelId}` : "Unnamed profile")
	const currentCatalog = useProviderModels(profile.provider || "")
	const source =
		profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
		profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API ||
		profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT ||
		profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED
			? profile.imageSource
			: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED
	const selectedImageProfile = imageProfiles.find((candidate) => candidate.id === profile.imageProfileId && candidate.enabled)
	const imageProvider =
		source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT
			? selectedImageProfile?.provider || ""
			: profile.provider || ""
	const selectedCatalog = useProviderModels(imageProvider)
	const hasIndependent = imageProfiles.some((candidate) => candidate.enabled)
	const imageModels = Object.fromEntries(
		Object.entries(selectedCatalog.imageModels).filter(([modelId]) => modelId !== GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID),
	)
	const defaultImageModelId = selectedCatalog.defaultImageModelId
	const effectiveImageModelId =
		profile.imageModelId && imageModels[profile.imageModelId] ? profile.imageModelId : defaultImageModelId
	const models = currentCatalog.models
	const catalogModelInfo = models[profile.modelId]
	const selectedModelInfo = resolveProfileModelInfo(profile, currentCatalog)
	const selectedApiFormat = profile.openai?.apiFormat ?? profile.modelInfo?.apiFormats?.[0] ?? catalogModelInfo?.apiFormats?.[0]
	const supportsResponses =
		selectedApiFormat === ApiFormat.OPENAI_RESPONSES || selectedApiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	const hasCurrentImageCatalog =
		Object.keys(currentCatalog.imageModels).length > 0 && Boolean(currentCatalog.defaultImageModelId)
	const supportsGptSubscription =
		((profile.provider === "openai" && supportsResponses) || profile.provider === "openai-codex") && hasCurrentImageCatalog
	const supportsGptApi = profile.provider === "openai" && hasCurrentImageCatalog
	const supportsHosted =
		((profile.provider === "openai" && supportsResponses) || profile.provider === "openai-codex") && hasCurrentImageCatalog

	const toggleUse = (mode: "act" | "plan" | "subagents"): void => {
		onUpdate({
			usedFor: profile.usedFor.includes(mode)
				? profile.usedFor.filter((item) => item !== mode)
				: [...profile.usedFor, mode],
		})
	}

	// Build detailed tooltip from modelInfo
	const info = selectedModelInfo
	const reasoning = resolveProfileReasoningConfig(profile)
	const thinking = resolveTaskThinkingConfig(info?.capabilities)
	const thinkingSummary =
		profile.provider === "deepseek"
			? formatDeepSeekThinkingSummary(reasoning, thinking)
			: formatThinkingSummary(reasoning, thinking)
	const subtitle = [providerLabel, modelLabel, thinkingSummary].filter(Boolean).join(" · ")
	const displayLine = [profileName, subtitle].filter(Boolean).join(" · ")
	const tooltipLines: string[] = [displayLine]
	if (info) {
		const mi = info
		if (mi.capabilities?.contextWindow)
			tooltipLines.push(`Context: ${mi.capabilities?.contextWindow.toLocaleString()} tokens`)
		if (mi.pricing?.inputPrice != null)
			tooltipLines.push(`In: $${mi.pricing?.inputPrice}/M | Out: $${mi.pricing?.outputPrice ?? "?"}/M`)
		if (mi.capabilities?.supportsReasoning)
			tooltipLines.push(`Reasoning: ${mi.capabilities?.thinking?.effortLevels?.join(", ") || "supported"}`)
		if (mi.capabilities?.supportsImages) tooltipLines.push("Images: supported")
		if (mi.capabilities?.supportsPromptCache) tooltipLines.push("Prompt cache: supported")
		if (mi.description) tooltipLines.push(mi.description)
	}
	const cardTooltip = tooltipLines.join("\n")

	return (
		<div className="mb-1.5 border-b border-editor-widget-border/35" data-testid="api-profile-card">
			<div
				className="flex min-w-0 items-start gap-1 px-1 py-1 hover:bg-(--vscode-list-hoverBackground)"
				title={cardTooltip}>
				{editMode ? (
					<input
						aria-label={`Select ${profileName}`}
						checked={selected ?? false}
						className="size-4 shrink-0 cursor-pointer"
						onChange={() => onToggleSelect?.()}
						type="checkbox"
					/>
				) : null}
				{dragHandle}
				<button
					aria-label={isExpanded ? `Collapse ${profileName}` : `Expand ${profileName}`}
					className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent text-description hover:bg-toolbar-hover hover:text-foreground"
					onClick={onToggleExpand}
					type="button">
					{isExpanded ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
				</button>
				<div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-0.5">
					{editMode || isExpanded ? (
						<input
							aria-label="Profile name"
							className="col-span-2 min-h-7 min-w-0 w-full max-w-80 justify-self-start bg-transparent px-1 text-sm font-medium text-foreground outline-none focus:bg-input-background focus:ring-1 focus:ring-border xs:col-span-1 xs:col-start-1 xs:row-start-1"
							defaultValue={profile.name}
							key={`${profile.id}:${profile.name}`}
							onBlur={(event) => {
								if (event.target.value !== profile.name) onUpdate({ name: event.target.value })
							}}
							placeholder={profileName}
						/>
					) : (
						<span className="col-span-2 truncate text-sm font-medium leading-5 text-foreground xs:col-span-1 xs:col-start-1 xs:row-start-1">
							{profileName}
						</span>
					)}
					<span className="col-start-1 row-start-2 min-w-0 truncate text-xs leading-5 text-description xs:col-span-2">
						{subtitle}
					</span>
					<div
						className="col-start-2 row-start-2 ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1 xs:row-start-1"
						data-testid="profile-summary-tail">
						<ProfileUsageBadges usedFor={profile.usedFor} />
						<ProfileCapabilityIcons capabilities={info?.capabilities} />
					</div>
				</div>
			</div>

			{/* Expanded: delegate to ApiProfileEditor */}
			{isExpanded && (
				<ProfileForm className="border-t border-editor-widget-border/30 px-3 pb-3 pt-3">
					<ProfileField htmlFor={`profile-provider-${profile.id}`} label="Provider">
						<select
							aria-label="Provider"
							className="min-h-7 w-full rounded-xs border border-input-border bg-input-background px-2 text-sm"
							id={`profile-provider-${profile.id}`}
							onChange={(e) => {
								const provider = e.target.value
								const keepsIndependentSource =
									profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT
								const keepsOpenAISource =
									(provider === "openai" &&
										(profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
											profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API ||
											profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED)) ||
									(provider === "openai-codex" &&
										(profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
											profile.imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED))
								const imageSource =
									keepsIndependentSource || keepsOpenAISource
										? profile.imageSource
										: ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED
								const imageModelId =
									imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT
										? profile.imageModelId
										: imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
												imageSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API
											? getCachedProviderDefaultImageModelId(provider)
											: undefined
								const updates = {
									provider,
									apiKey: "",
									baseUrl: undefined,
									modelId: getCachedProviderDefaultModelId(provider),
									imageSource,
									imageProfileId: keepsIndependentSource ? profile.imageProfileId : undefined,
									imageModelId: imageModelId || undefined,
									usedFor: profile.usedFor,
									modelInfo: undefined,
									name: "",
								} as Partial<ApiProfile> & Record<string, unknown>
								for (const key of Object.values(PROFILE_PROVIDER_KEYS)) {
									if (key) updates[key] = undefined
								}
								if (e.target.value === "anthropic") {
									updates.anthropic = AnthropicProviderConfig.create({ enableLongContext: true })
								}
								onUpdate(updates)
							}}
							value={profile.provider}>
							<option value="">Select provider...</option>
							{providerOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</ProfileField>

					{hasProvider && profile.provider !== "openai" && profile.provider !== "deepseek" && (
						<WebToolsModeControl
							onChange={(webToolsMode) => onUpdate({ webToolsMode })}
							value={profile.webToolsMode}
						/>
					)}

					<ProfileSection aria-label="Profile usage">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							{(["act", "plan", "subagents"] as const).map((mode) => (
								<label className="flex cursor-pointer items-center gap-1 text-sm" key={mode}>
									<input
										checked={profile.usedFor.includes(mode)}
										className="w-3 h-3"
										onChange={() => toggleUse(mode)}
										type="checkbox"
									/>
									<span>{mode === "act" ? "Act" : mode === "plan" ? "Plan" : "Subagents"}</span>
								</label>
							))}
						</div>
					</ProfileSection>

					{imageGenerationEnabled ? (
						<ProfileSection aria-label="Image source">
							<ProfileField label="Image source">
								<select
									aria-label="Image source"
									className="min-h-7 w-full rounded-xs border border-input-border bg-input-background px-2 text-sm"
									onChange={(event) => {
										const nextSource = Number(event.target.value) as ImageGenerationSource
										const independent = imageProfiles.find((candidate) => candidate.enabled)
										const provider =
											nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
											nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API
												? profile.provider
												: nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT
													? independent?.provider
													: undefined
										onUpdate({
											imageSource: nextSource,
											imageProfileId:
												nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT
													? independent?.id
													: undefined,
											imageModelId:
												nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
												nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API ||
												nextSource === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT
													? getCachedProviderDefaultImageModelId(provider || "") || undefined
													: undefined,
										})
									}}
									value={source}>
									<option value={ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED}>None</option>
									{supportsGptSubscription ? (
										<option value={ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION}>
											GPT Subscription
										</option>
									) : null}
									{supportsGptApi ? (
										<option value={ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API}>GPT API</option>
									) : null}
									{hasIndependent ? (
										<option value={ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT}>
											Independent
										</option>
									) : null}
									{supportsHosted ? (
										<option value={ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED}>Hosted</option>
									) : null}
								</select>
							</ProfileField>
							{source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT ? (
								<ProfileField label="Image profile">
									<select
										aria-label="Image profile"
										className="min-h-7 w-full rounded-xs border border-input-border bg-input-background px-2 text-sm"
										onChange={(event) => {
											const selected = imageProfiles.find(
												(candidate) => candidate.id === event.target.value,
											)
											onUpdate({
												imageProfileId: selected?.id,
												imageModelId:
													getCachedProviderDefaultImageModelId(selected?.provider || "") || undefined,
											})
										}}
										value={selectedImageProfile?.id || ""}>
										<option value="">Select image profile...</option>
										{imageProfiles
											.filter((candidate) => candidate.enabled)
											.map((candidate) => (
												<option key={candidate.id} value={candidate.id}>
													{candidate.name}
												</option>
											))}
									</select>
								</ProfileField>
							) : null}
							{source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED ? (
								<p className="m-0 text-xs text-description">
									{profile.provider === "openai-codex"
										? "Uses ChatGPT Codex Responses hosted image generation with the signed-in subscription."
										: "Uses OpenAI Responses hosted image generation and separate API Platform billing. ChatGPT/GPT subscriptions are not used."}
								</p>
							) : source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION ||
								source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_API ||
								source === ImageGenerationSource.IMAGE_GENERATION_SOURCE_INDEPENDENT ? (
								<ProfileField label="Image model">
									<select
										aria-label="Image model"
										className="min-h-7 w-full rounded-xs border border-input-border bg-input-background px-2 text-sm"
										onChange={(event) => onUpdate({ imageModelId: event.target.value })}
										value={effectiveImageModelId || ""}>
										{Object.entries(imageModels).map(([modelId, model]) => (
											<option key={modelId} value={modelId}>
												{model.name || modelId}
											</option>
										))}
									</select>
								</ProfileField>
							) : null}
						</ProfileSection>
					) : null}

					{hasProvider ? (
						<ProfileSection className="gap-3 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:!gap-3">
							<ApiProfileEditor isPopup={false} onUpdateProfile={onUpdate} profile={profile} />
						</ProfileSection>
					) : null}
				</ProfileForm>
			)}
		</div>
	)
}

export default ApiProfileCard
