import { geminiModels, ModelInfo } from "@shared/api"
import type { ContextWindowBand } from "@shared/proto/dline/models/metadata"
import { readBands, readCurrency, readPriceSet } from "@shared/providers/pricing-shape"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { CheckIcon, MinusIcon } from "lucide-react"
import { useId } from "react"
import styled from "styled-components"
import { formatCurrencyAmount, getCurrencySymbol } from "@/utils/currency"
import { ModelDescriptionMarkdown } from "../ModelDescriptionMarkdown"
import { ProfileField } from "../profile-ui"
import { hasThinkingBudget, supportsBrowserUse, supportsImages, supportsPromptCache } from "../utils/pricingUtils"

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
    bands: readonly ContextWindowBand[],
    priceType: "inputPrice" | "outputPrice" | "cacheReadPrice" | "cacheWritePrice",
    currency?: string,
): JSX.Element[] => {
    if (bands.length === 0) {
        return []
    }

    return bands
        .map((band, index) => {
            const prevLimit = index > 0 ? bands[index - 1].maxInputTokens : 0
            const prices = readPriceSet(band.prices)
            const price = prices[priceType]

            if (price === undefined) {
                return null
            }

            return (
                <span key={`band-${index}`} style={{ paddingLeft: "15px" }}>
                    {formatCurrencyAmount(price, currency)}/million tokens (
                    {band.maxInputTokens === undefined ? (
                        <span>
                            {">"} {(prevLimit ?? 0).toLocaleString()} input tokens
                        </span>
                    ) : (
                        <span>
                            {"<="} {band.maxInputTokens.toLocaleString()} input tokens
                        </span>
                    )}
                    {")"}
                    {index < bands.length - 1 && <br />}
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
    const bands = readBands(modelInfo.pricing)
    const hasTiers = bands.length > 0
    const contextTiers = modelInfo.capabilities?.contextWindowTiers ?? []
    const currency = readCurrency(modelInfo.pricing)
    const flatPrices = modelInfo.pricing?.metered?.strategy?.flat?.prices
    const flatRates = readPriceSet(flatPrices)
    const thinkingOutputPrice = flatPrices?.thinkingOutputPrice

    // Capability checks
    const hasImages = supportsImages(modelInfo)
    const hasBrowser = supportsBrowserUse(modelInfo)
    const hasCaching = !isGemini && supportsPromptCache(modelInfo)
    const hasNativeTools = modelInfo.capabilities?.supportsTools === true
    const hasReasoning =
        modelInfo.capabilities?.supportsReasoning === true || modelInfo.capabilities?.thinking?.supported === true

    // Check if we have cache pricing to show in Advanced section
    const hasCachePricing = modelInfo.capabilities?.supportsPromptCache && (flatRates.cacheWritePrice || flatRates.cacheReadPrice)

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
                {flatPrices?.inputPrice !== undefined && (
                    <InfoItem>
                        <InfoLabel>Input: </InfoLabel>
                        <InfoValue>{formatCompactPrice(flatPrices.inputPrice, currency)}</InfoValue>
                    </InfoItem>
                )}
                {flatPrices?.outputPrice !== undefined && (
                    <InfoItem>
                        <InfoLabel>Output: </InfoLabel>
                        <InfoValue>
                            {hasThinkingConfig && thinkingOutputPrice !== undefined
                                ? formatCompactPrice(thinkingOutputPrice, currency)
                                : formatCompactPrice(flatPrices.outputPrice, currency)}
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
                        {flatPrices?.cacheReadPrice !== undefined && (
                            <AdvancedRow>
                                <AdvancedLabel>Cache Reads</AdvancedLabel>
                                <AdvancedValue>{formatCompactPrice(flatPrices.cacheReadPrice, currency)}</AdvancedValue>
                            </AdvancedRow>
                        )}
                        {flatPrices?.cacheWritePrice !== undefined && (
                            <AdvancedRow>
                                <AdvancedLabel>Cache Writes</AdvancedLabel>
                                <AdvancedValue>{formatCompactPrice(flatPrices.cacheWritePrice, currency)}</AdvancedValue>
                            </AdvancedRow>
                        )}
                    </>
                )}

                {/* Tiered Pricing */}
                {hasTiers && (
                    <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 500, marginBottom: 4 }}>Tiered Pricing:</div>
                        <AdvancedRow>
                            <AdvancedLabel>Input</AdvancedLabel>
                            <AdvancedValue>{formatTiers(bands, "inputPrice", currency)}</AdvancedValue>
                        </AdvancedRow>
                        <AdvancedRow>
                            <AdvancedLabel>Output</AdvancedLabel>
                            <AdvancedValue>{formatTiers(bands, "outputPrice", currency)}</AdvancedValue>
                        </AdvancedRow>
                        {modelInfo.capabilities?.supportsPromptCache && (
                            <>
                                <AdvancedRow>
                                    <AdvancedLabel>Cache Writes</AdvancedLabel>
                                    <AdvancedValue>{formatTiers(bands, "cacheWritePrice", currency)}</AdvancedValue>
                                </AdvancedRow>
                                <AdvancedRow>
                                    <AdvancedLabel>Cache Reads</AdvancedLabel>
                                    <AdvancedValue>{formatTiers(bands, "cacheReadPrice", currency)}</AdvancedValue>
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
