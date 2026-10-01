import { CLAUDE_SONNET_1M_SUFFIX, openRouterDefaultModelId } from "@shared/api"
import { StringRequest } from "@shared/proto/dline/common"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { ClineProviderConfig } from "@shared/proto/dline/provider/cline_provider"
import { OpenRouterProviderConfig } from "@shared/proto/dline/provider/openrouter"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import type React from "react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { useMount } from "react-use"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { highlight } from "../history/HistoryView"
import { ContextWindowSwitcher } from "./common/ContextWindowSwitcher"
import { ModelInfoView } from "./common/ModelInfoView"
import ThinkingControl from "./ThinkingControl"
import { filterOpenRouterModelIds } from "./utils/providerUtils"

// Star icon for favorites
const StarIcon = ({ isFavorite, onClick }: { isFavorite: boolean; onClick: (e: React.MouseEvent) => void }) => {
	return (
		<div
			onClick={onClick}
			style={{
				cursor: "pointer",
				color: isFavorite ? "var(--vscode-terminal-ansiBlue)" : "var(--vscode-descriptionForeground)",
				marginLeft: "8px",
				fontSize: "16px",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				userSelect: "none",
				WebkitUserSelect: "none",
			}}>
			{isFavorite ? "★" : "☆"}
		</div>
	)
}

export interface OpenRouterModelPickerProps {
	isPopup?: boolean
	onUpdate: (updates: Partial<ApiProfile>) => void
	profile: ApiProfile
	showProviderRouting?: boolean
}

const OpenRouterModelPicker: React.FC<OpenRouterModelPickerProps> = ({ isPopup, onUpdate, profile, showProviderRouting }) => {
	const state = useExtensionState()
	const { favoritedModelIds } = state
	const isCline = profile.provider === "cline"
	const pickerModels = isCline ? (state.clineModels ?? {}) : state.openRouterModels
	const refreshModels = isCline ? state.refreshClineModels : state.refreshOpenRouterModels
	const selectedModelId = profile.modelId || profile.modelInfo?.id || openRouterDefaultModelId
	const clineConfig = profile.clineProvider ?? ClineProviderConfig.create()
	const openrouterConfig = profile.openrouter ?? OpenRouterProviderConfig.create()
	const providerConfig = isCline ? clineConfig : openrouterConfig
	const baseModel = pickerModels[selectedModelId] ?? (profile.modelInfo?.id === selectedModelId ? profile.modelInfo : undefined)
	const selectedModelInfo = useMemo(
		() =>
			baseModel || providerConfig.capabilities
				? buildEffectiveModelInfo(selectedModelId, baseModel, {
						capabilities: providerConfig.capabilities,
						pricing: providerConfig.pricing,
					})
				: undefined,
		[baseModel, selectedModelId, providerConfig.capabilities, providerConfig.pricing],
	)
	const [searchTerm, setSearchTerm] = useState(selectedModelId)
	const [isDropdownVisible, setIsDropdownVisible] = useState(false)
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dropdownRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	const dropdownListRef = useRef<HTMLDivElement>(null)

	const handleModelChange = (newModelId: string) => {
		setSearchTerm(newModelId)
		onUpdate({ modelId: newModelId, modelInfo: pickerModels[newModelId] })
	}

	useMount(() => {
		refreshModels()
	})

	// Sync external changes when the modelId changes
	useEffect(() => {
		setSearchTerm(selectedModelId)
	}, [selectedModelId])

	useEffect(() => {
		if (!profile.modelId && baseModel) {
			onUpdate({ modelId: selectedModelId, modelInfo: baseModel })
		}
	}, [onUpdate, profile.modelId, selectedModelId, baseModel])

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownVisible(false)
			}
		}

		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [])

	const modelIds = useMemo(() => {
		const unfilteredModelIds = Object.keys(pickerModels).sort((a, b) => a.localeCompare(b))
		return filterOpenRouterModelIds(unfilteredModelIds, isCline ? "cline" : "openrouter")
	}, [pickerModels, isCline])

	const searchableItems = useMemo(() => {
		return modelIds.map((id) => ({
			id,
			html: id,
		}))
	}, [modelIds])

	const fuse = useMemo(() => {
		return new Fuse(searchableItems, {
			keys: ["html"], // highlight function will update this
			threshold: 0.6,
			shouldSort: true,
			isCaseSensitive: false,
			ignoreLocation: false,
			includeMatches: true,
			minMatchCharLength: 1,
		})
	}, [searchableItems])

	const modelSearchResults = useMemo(() => {
		// IMPORTANT: highlightjs has a bug where if you use sort/localCompare - "// results.sort((a, b) => a.id.localeCompare(b.id)) ...sorting like this causes ids in objects to be reordered and mismatched"

		// First, get all favorited models
		const favoritedModels = searchableItems.filter((item) => favoritedModelIds.includes(item.id))

		// Then get search results for non-favorited models
		const searchResults = searchTerm
			? highlight(fuse.search(searchTerm), "model-item-highlight").filter((item) => !favoritedModelIds.includes(item.id))
			: searchableItems.filter((item) => !favoritedModelIds.includes(item.id))

		// Combine favorited models with search results
		return [...favoritedModels, ...searchResults]
	}, [searchableItems, searchTerm, fuse, favoritedModelIds])

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!isDropdownVisible) {
			return
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault()
				setSelectedIndex((prev) => (prev < modelSearchResults.length - 1 ? prev + 1 : prev))
				break
			case "ArrowUp":
				event.preventDefault()
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
				break
			case "Enter":
				event.preventDefault()
				if (selectedIndex >= 0 && selectedIndex < modelSearchResults.length) {
					handleModelChange(modelSearchResults[selectedIndex].id)
					setIsDropdownVisible(false)
				} else {
					// User typed a custom model ID
					handleModelChange(searchTerm)
					setIsDropdownVisible(false)
				}
				break
			case "Escape":
				setIsDropdownVisible(false)
				setSelectedIndex(-1)
				break
		}
	}

	useEffect(() => {
		setSelectedIndex(-1)
		if (dropdownListRef.current) {
			dropdownListRef.current.scrollTop = 0
		}
	}, [])

	useEffect(() => {
		if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			})
		}
	}, [selectedIndex])

	const thinking = selectedModelInfo?.capabilities?.thinking
	const thinkingSupported = thinking?.supported === true && selectedModelInfo?.capabilities?.supportsReasoning !== false
	const effortSupported = thinkingSupported && thinking?.mode === "effort"
	const budgetSupported = thinkingSupported && thinking?.mode === "budget"

	return (
		<div style={{ width: "100%", paddingBottom: 2 }}>
			<style>
				{`
				.model-item-highlight {
					background-color: var(--vscode-editor-findMatchHighlightBackground);
					color: inherit;
				}
				`}
			</style>
			<div style={{ display: "flex", flexDirection: "column" }}>
				<label htmlFor="model-search">
					<span style={{ fontWeight: 500 }}>Model</span>
				</label>

				<DropdownWrapper ref={dropdownRef}>
					<VSCodeTextField
						aria-label="Model"
						id="model-search"
						onBlur={() => {
							if (searchTerm !== selectedModelId) {
								handleModelChange(searchTerm)
							}
						}}
						onFocus={() => setIsDropdownVisible(true)}
						onInput={(e) => {
							setSearchTerm((e.target as HTMLInputElement)?.value.toLowerCase() || "")
							setIsDropdownVisible(true)
						}}
						onKeyDown={handleKeyDown}
						placeholder="Search and select a model..."
						role="combobox"
						style={{
							width: "100%",
							zIndex: OPENROUTER_MODEL_PICKER_Z_INDEX,
							position: "relative",
						}}
						value={searchTerm}>
						{searchTerm && (
							<div
								aria-label="Clear search"
								className="input-icon-button codicon codicon-close"
								onClick={() => {
									setSearchTerm("")
									setIsDropdownVisible(true)
								}}
								slot="end"
								style={{
									display: "flex",
									justifyContent: "center",
									alignItems: "center",
									height: "100%",
								}}
							/>
						)}
					</VSCodeTextField>
					{isDropdownVisible && (
						<DropdownList ref={dropdownListRef} role="listbox">
							{modelSearchResults.map((item, index) => {
								const isFavorite = (favoritedModelIds || []).includes(item.id)
								return (
									<DropdownItem
										isSelected={index === selectedIndex}
										key={item.id}
										onClick={() => {
											handleModelChange(item.id)
											setIsDropdownVisible(false)
										}}
										onMouseEnter={() => setSelectedIndex(index)}
										ref={(el) => (itemRefs.current[index] = el)}
										role="option">
										<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
											<span dangerouslySetInnerHTML={{ __html: item.html }} />
											<StarIcon
												isFavorite={isFavorite}
												onClick={(e) => {
													e.stopPropagation()
													StateServiceClient.toggleFavoriteModel(
														StringRequest.create({ value: item.id }),
													).catch((error) => console.error("Failed to toggle favorite model:", error))
												}}
											/>
										</div>
									</DropdownItem>
								)
							})}
						</DropdownList>
					)}
				</DropdownWrapper>

				{/* Context window switcher for Claude Opus 4.7 */}
				<ContextWindowSwitcher
					base1mModelId={`anthropic/claude-opus-4.7${CLAUDE_SONNET_1M_SUFFIX}`}
					base200kModelId="anthropic/claude-opus-4.7"
					onModelChange={handleModelChange}
					selectedModelId={selectedModelId}
				/>

				{/* Context window switcher for Claude Opus 4.6 */}
				<ContextWindowSwitcher
					base1mModelId={`anthropic/claude-opus-4.6${CLAUDE_SONNET_1M_SUFFIX}`}
					base200kModelId="anthropic/claude-opus-4.6"
					onModelChange={handleModelChange}
					selectedModelId={selectedModelId}
				/>

				{/* Context window switcher for Claude Sonnet 4.6 */}
				<ContextWindowSwitcher
					base1mModelId={`anthropic/claude-sonnet-4.6${CLAUDE_SONNET_1M_SUFFIX}`}
					base200kModelId="anthropic/claude-sonnet-4.6"
					onModelChange={handleModelChange}
					selectedModelId={selectedModelId}
				/>

				{/* Context window switcher for Claude Sonnet 4.5 */}
				<ContextWindowSwitcher
					base1mModelId={`anthropic/claude-sonnet-4.5${CLAUDE_SONNET_1M_SUFFIX}`}
					base200kModelId="anthropic/claude-sonnet-4.5"
					onModelChange={handleModelChange}
					selectedModelId={selectedModelId}
				/>

				{/* Context window switcher for Claude Sonnet 4 */}
				<ContextWindowSwitcher
					base1mModelId={`anthropic/claude-sonnet-4${CLAUDE_SONNET_1M_SUFFIX}`}
					base200kModelId="anthropic/claude-sonnet-4"
					onModelChange={handleModelChange}
					selectedModelId={selectedModelId}
				/>
			</div>

			{selectedModelInfo ? (
				<>
					{(effortSupported || budgetSupported) && (
						<ThinkingControl
							defaultEffort={thinking?.defaultEffort}
							defaultEnabled={thinking?.defaultEnabled}
							disableSupported={thinking?.canDisable !== false}
							effortOptions={thinking?.effortLevels ?? []}
							maxBudget={thinking?.maxBudget}
							minBudget={thinking?.minBudget}
							mode={effortSupported ? "effort-only" : "budget-only"}
							onReasoningConfigUpdate={(reasoning) =>
								onUpdate(
									isCline
										? { clineProvider: { ...clineConfig, reasoning } }
										: { openrouter: { ...openrouterConfig, reasoning } },
								)
							}
							reasoningConfig={providerConfig.reasoning}
							showModeSelector={false}
						/>
					)}

					<ModelInfoView
						isPopup={isPopup}
						modelInfo={selectedModelInfo}
						onProviderSortingChange={
							isCline
								? undefined
								: (openRouterProviderSorting) =>
										onUpdate({ openrouter: { ...openrouterConfig, openRouterProviderSorting } })
						}
						providerSorting={isCline ? undefined : profile.openrouter?.openRouterProviderSorting}
						selectedModelId={selectedModelId}
						showProviderRouting={showProviderRouting}
					/>
				</>
			) : (
				<p
					style={{
						fontSize: "12px",
						marginTop: 0,
						color: "var(--vscode-descriptionForeground)",
					}}>
					The extension automatically fetches the latest list of models available on{" "}
					<VSCodeLink href="https://openrouter.ai/models" style={{ display: "inline", fontSize: "inherit" }}>
						OpenRouter.
					</VSCodeLink>
					If you're unsure which model to choose, Dline works best with{" "}
					<VSCodeLink
						onClick={() => handleModelChange("anthropic/claude-sonnet-4.6")}
						style={{ display: "inline", fontSize: "inherit" }}>
						anthropic/claude-sonnet-4.6.
					</VSCodeLink>
					You can also try searching "free" for no-cost options currently available.
				</p>
			)}
		</div>
	)
}

export default OpenRouterModelPicker

// Dropdown

const DropdownWrapper = styled.div`
	position: relative;
	width: 100%;
`

export const OPENROUTER_MODEL_PICKER_Z_INDEX = 1_000

const DropdownList = styled.div`
	position: absolute;
	top: calc(100% - 3px);
	left: 0;
	width: calc(100% - 2px);
	max-height: 200px;
	overflow-y: auto;
	background-color: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-list-activeSelectionBackground);
	z-index: ${OPENROUTER_MODEL_PICKER_Z_INDEX - 1};
	border-bottom-left-radius: 3px;
	border-bottom-right-radius: 3px;
`

const DropdownItem = styled.div<{ isSelected: boolean }>`
	padding: 5px 10px;
	cursor: pointer;
	word-break: break-all;
	white-space: normal;

	background-color: ${({ isSelected }) => (isSelected ? "var(--vscode-list-activeSelectionBackground)" : "inherit")};

	&:hover {
		background-color: var(--vscode-list-activeSelectionBackground);
	}
`
