import { geminiModels, ModelInfo } from "@shared/api"
import type { PricingTier } from "@shared/providers/types"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { CheckIcon, MinusIcon } from "lucide-react"
import { useId } from "react"
import styled from "styled-components"
import { ModelDescriptionMarkdown } from "../ModelDescriptionMarkdown"
import { ProfileField } from "../profile-ui"
import {
	formatPrice,
	getCurrencySymbol,
	hasThinkingBudget,
	supportsBrowserUse,
	supportsImages,
	supportsPromptCache,
} from "../utils/pricingUtils"

// ========== Styled Components ==========

const InfoRow = styled.div`
	display: flex;
	column-gap: 16px;
	row-gap: 4px;
	font-size: calc(var(--vscode-font-size) * 0.85);
	color: var(--vscode-foreground);
	margin-top: 8px;
	flex-wrap: wrap;
`

const InfoItem = styled.span`
	white-space: nowrap;
`

const InfoLabel = styled.span`
	color: var(--vscode-descriptionForeground);
`

const InfoValue = styled.span`
	font-weight: 500;
`

const AdvancedSection = styled.div`
	font-size: calc(var(--vscode-font-size) * 0.85);
	color: var(--vscode-descriptionForeground);
`

const AdvancedRow = styled.div`
	display: flex;
	justify-content: space-between;
	padding: 4px 0;
`

const AdvancedLabel = styled.span``

const AdvancedValue = styled.span`
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--vscode-foreground);
`

const SupportedIcon = styled(CheckIcon)`
	width: 14px;
	height: 14px;
	color: var(--vscode-charts-green, var(--vscode-testing-iconPassed, var(--vscode-foreground)));
`

const UnsupportedIcon = styled(MinusIcon)`
	width: 14px;
	height: 14px;
	color: var(--vscode-descriptionForeground);
`

/** One capability row: an icon carries the state, the text names it. */
function CapabilityValue({ supported }: { supported: boolean }) {
	return (
		<AdvancedValue>
			{supported ? <SupportedIcon aria-hidden="true" /> : <UnsupportedIcon aria-hidden="true" />}
			{supported ? "Yes" : "No"}
		</AdvancedValue>
	)
}

// ========== Helper Functions ==========

/**
 * Format price for compact display (e.g., "$5/M" for $5 per million tokens)
 * Price is already in per-million format from OpenRouter
 */
const formatCompactPrice = (price: number | undefined, currency?: string): string => {
	if (price === undefined) {
		return "N/A"
	}
	if (price === 0) {
		return "Free"
	}
	const symbol = getCurrencySymbol(currency)
	if (price < 0.01) {
		return `${symbol}${price.toFixed(4)}/M`
	}
	if (price < 1) {
		return `${symbol}${price.toFixed(2)}/M`
	}
	return `${symbol}${price % 1 === 0 ? price : price.toFixed(2)}/M`
}

/**
 * Format context window for compact display (e.g., "200K")
 */
const formatCompactContext = (contextWindow: number | undefined): string => {
	if (!contextWindow) {
		return "N/A"
	}
	if (contextWindow >= 1_000_000) {
		return `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
	}
	return `${Math.round(contextWindow / 1000)}K`
}

/**
 * Format usage-based tiered pricing: each tier's threshold is the maximum
 * input-token usage for that price band. The threshold controls pricing only,
 * not the context window.
 */
const formatTiers = (
	tiers: PricingTier[],
	priceType: "inputPrice" | "outputPrice" | "cacheReadsPrice" | "cacheWritesPrice",
	currency?: string,
): JSX.Element[] => {
	if (!tiers || tiers.length === 0) {
		return []
	}

	return tiers
		.map((tier, index, arr) => {
			const prevLimit = index > 0 ? arr[index - 1].contextWindow : 0
			const price = tier[priceType]

			if (price === undefined) {
				return null
			}

			return (
				<span key={`tier-${tier.contextWindow}`} style={{ paddingLeft: "15px" }}>
					{formatPrice(price, currency)}/million tokens (
					{tier.contextWindow === Number.POSITIVE_INFINITY || tier.contextWindow >= Number.MAX_SAFE_INTEGER ? (
						<span>
							{">"} {prevLimit.toLocaleString()} input tokens
						</span>
					) : (
						<span>
							{"<="} {tier.contextWindow?.toLocaleString()} input tokens
						</span>
					)}
					{")"}
					{index < arr.length - 1 && <br />}
				</span>
			)
		})
		.filter((element): element is JSX.Element => element !== null)
}

// ========== Props ==========

interface ModelInfoViewProps {
	selectedModelId: string
	modelInfo: ModelInfo
	isPopup?: boolean
	// Provider routing props (optional - only shown for Cline provider)
	providerSorting?: string
	onProviderSortingChange?: (value: string) => void
	showProviderRouting?: boolean
}

// ========== Component ==========

export const ModelInfoView = ({
	selectedModelId,
	modelInfo,
	isPopup,
	providerSorting,
	onProviderSortingChange,
	showProviderRouting,
}: ModelInfoViewProps) => {
	const providerRoutingId = useId()
	const isGemini = Object.keys(geminiModels).includes(selectedModelId)
	const hasThinkingConfig = hasThinkingBudget(modelInfo)
	const hasTiers = !!modelInfo.pricing?.tiers && modelInfo.pricing.tiers.length > 0
	const contextTiers = modelInfo.capabilities?.contextWindowTiers ?? []
	const currency = modelInfo.pricing?.currency

	// Capability checks
	const hasImages = supportsImages(modelInfo)
	const hasBrowser = supportsBrowserUse(modelInfo)
	const hasCaching = !isGemini && supportsPromptCache(modelInfo)
	const hasNativeTools = modelInfo.capabilities?.supportsTools === true
	const hasReasoning =
		modelInfo.capabilities?.supportsReasoning === true || modelInfo.capabilities?.thinking?.supported === true

	// Check if we have cache pricing to show in Advanced section
	const hasCachePricing =
		modelInfo.capabilities?.supportsPromptCache && (modelInfo.pricing?.cacheWritesPrice || modelInfo.pricing?.cacheReadsPrice)

	return (
		<div className="min-w-0">
			{/* Description */}
			{modelInfo.description && (
				<ModelDescriptionMarkdown isPopup={isPopup} key="description" markdown={modelInfo.description} />
			)}

			{/* Compact Info Row: Context, Input, Output */}
			<InfoRow>
				{modelInfo.capabilities?.contextWindow !== undefined && modelInfo.capabilities?.contextWindow > 0 && (
					<InfoItem>
						<InfoLabel>Context: </InfoLabel>
						<InfoValue>{formatCompactContext(modelInfo.capabilities?.contextWindow)}</InfoValue>
					</InfoItem>
				)}
				{modelInfo.capabilities?.maxTokens !== undefined && modelInfo.capabilities.maxTokens > 0 && (
					<InfoItem>
						<InfoLabel>Max Output: </InfoLabel>
						<InfoValue>{formatCompactContext(modelInfo.capabilities.maxTokens)}</InfoValue>
					</InfoItem>
				)}
				{modelInfo.pricing?.inputPrice !== undefined && (
					<InfoItem>
						<InfoLabel>Input: </InfoLabel>
						<InfoValue>{formatCompactPrice(modelInfo.pricing.inputPrice, currency)}</InfoValue>
					</InfoItem>
				)}
				{modelInfo.pricing?.outputPrice !== undefined && (
					<InfoItem>
						<InfoLabel>Output: </InfoLabel>
						<InfoValue>
							{hasThinkingConfig && modelInfo.pricing?.thinkingOutputPrice !== undefined
								? formatCompactPrice(modelInfo.pricing.thinkingOutputPrice, currency)
								: formatCompactPrice(modelInfo.pricing.outputPrice, currency)}
						</InfoValue>
					</InfoItem>
				)}
			</InfoRow>

			{/* Capabilities, tiers and routing stay visible; hiding them behind a
			    disclosure made the model's actual limits easy to miss. */}
			<AdvancedSection>
				<AdvancedRow>
					<AdvancedLabel>Images</AdvancedLabel>
					<CapabilityValue supported={hasImages} />
				</AdvancedRow>
				<AdvancedRow>
					<AdvancedLabel>Browser</AdvancedLabel>
					<CapabilityValue supported={hasBrowser} />
				</AdvancedRow>
				<AdvancedRow>
					<AdvancedLabel>Native Tool Calls</AdvancedLabel>
					<CapabilityValue supported={hasNativeTools} />
				</AdvancedRow>
				<AdvancedRow>
					<AdvancedLabel>Reasoning</AdvancedLabel>
					<CapabilityValue supported={hasReasoning} />
				</AdvancedRow>
				{!isGemini && (
					<AdvancedRow>
						<AdvancedLabel>Prompt Caching</AdvancedLabel>
						<CapabilityValue supported={hasCaching} />
					</AdvancedRow>
				)}

				{contextTiers.length > 0 && (
					<div style={{ marginTop: 8 }}>
						<div style={{ fontWeight: 500, marginBottom: 4 }}>Context Window Tiers:</div>
						{contextTiers.map((tier) => (
							<AdvancedRow key={tier.id}>
								<AdvancedLabel>{tier.label || tier.id}</AdvancedLabel>
								<AdvancedValue>{formatCompactContext(tier.contextWindow)}</AdvancedValue>
							</AdvancedRow>
						))}
					</div>
				)}

				{/* Cache Pricing */}
				{hasCachePricing && (
					<>
						{modelInfo.pricing?.cacheReadsPrice !== undefined && (
							<AdvancedRow>
								<AdvancedLabel>Cache Reads</AdvancedLabel>
								<AdvancedValue>{formatCompactPrice(modelInfo.pricing?.cacheReadsPrice, currency)}</AdvancedValue>
							</AdvancedRow>
						)}
						{modelInfo.pricing?.cacheWritesPrice !== undefined && (
							<AdvancedRow>
								<AdvancedLabel>Cache Writes</AdvancedLabel>
								<AdvancedValue>{formatCompactPrice(modelInfo.pricing?.cacheWritesPrice, currency)}</AdvancedValue>
							</AdvancedRow>
						)}
					</>
				)}

				{/* Tiered Pricing */}
				{hasTiers && modelInfo.pricing?.tiers && (
					<div style={{ marginTop: 8 }}>
						<div style={{ fontWeight: 500, marginBottom: 4 }}>Tiered Pricing:</div>
						<AdvancedRow>
							<AdvancedLabel>Input</AdvancedLabel>
							<AdvancedValue>{formatTiers(modelInfo.pricing.tiers, "inputPrice", currency)}</AdvancedValue>
						</AdvancedRow>
						<AdvancedRow>
							<AdvancedLabel>Output</AdvancedLabel>
							<AdvancedValue>{formatTiers(modelInfo.pricing.tiers, "outputPrice", currency)}</AdvancedValue>
						</AdvancedRow>
						{modelInfo.capabilities?.supportsPromptCache && (
							<>
								<AdvancedRow>
									<AdvancedLabel>Cache Writes</AdvancedLabel>
									<AdvancedValue>
										{formatTiers(modelInfo.pricing.tiers, "cacheWritesPrice", currency)}
									</AdvancedValue>
								</AdvancedRow>
								<AdvancedRow>
									<AdvancedLabel>Cache Reads</AdvancedLabel>
									<AdvancedValue>
										{formatTiers(modelInfo.pricing.tiers, "cacheReadsPrice", currency)}
									</AdvancedValue>
								</AdvancedRow>
							</>
						)}
					</div>
				)}

				{/* Provider Routing */}
				{showProviderRouting && onProviderSortingChange ? (
					<ProfileField
						description={
							<>
								{!providerSorting &&
									"Load balance across providers (AWS, Google Vertex, etc.), prioritizing price while considering uptime"}
								{providerSorting === "price" && "Sort by price, prioritizing the lowest cost provider"}
								{providerSorting === "throughput" &&
									"Sort by throughput, prioritizing highest throughput (may increase cost)"}
								{providerSorting === "latency" && "Sort by response time, prioritizing lowest latency"}
							</>
						}
						htmlFor={providerRoutingId}
						label="Provider Routing">
						<VSCodeDropdown
							aria-label="Provider Routing"
							className="min-h-7 w-full"
							id={providerRoutingId}
							onChange={(e: any) => onProviderSortingChange(e.target.value)}
							value={providerSorting || ""}>
							<VSCodeOption value="">Default</VSCodeOption>
							<VSCodeOption value="price">Price</VSCodeOption>
							<VSCodeOption value="throughput">Throughput</VSCodeOption>
							<VSCodeOption value="latency">Latency</VSCodeOption>
						</VSCodeDropdown>
					</ProfileField>
				) : null}
			</AdvancedSection>
		</div>
	)
}
