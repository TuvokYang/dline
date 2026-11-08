import { geminiModels, ModelInfo } from "@shared/api"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { CheckIcon, MinusIcon } from "lucide-react"
import { useId } from "react"
import styled from "styled-components"
import { ModelDescriptionMarkdown } from "../ModelDescriptionMarkdown"
import { ProfileField } from "../profile-ui"
import { supportsBrowserUse, supportsImages, supportsPromptCache } from "../utils/pricingUtils"
import { PricingEditor } from "./PricingEditor"

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

/**
 * One capability row: an icon carries the state, the text names it.
 *
 * `undefined` is the third state: nobody declared the capability. Rendering it
 * as "No" would turn an absent declaration into a claim the seller never made.
 */
function CapabilityValue({ supported }: { supported: boolean | undefined }) {
    if (supported === undefined) {
        return <AdvancedValue>Unknown</AdvancedValue>
    }
    return (
        <AdvancedValue>
            {supported ? <SupportedIcon aria-hidden="true" /> : <UnsupportedIcon aria-hidden="true" />}
            {supported ? "Yes" : "No"}
        </AdvancedValue>
    )
}

// ========== Helper Functions ==========

/** Format a declared context capacity, independently from pricing usage bands. */
const formatCompactContext = (contextWindow: number | undefined): string => {
    if (!contextWindow) {
        return "N/A"
    }
    if (contextWindow >= 1_000_000) {
        return `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
    }
    return `${Math.round(contextWindow / 1000)}K`
}

// ========== Props ==========

interface ModelInfoViewProps {
    selectedModelId: string
    modelInfo: ModelInfo
    isPopup?: boolean
    peakOffPeakLabels?: boolean
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
    peakOffPeakLabels,
    providerSorting,
    onProviderSortingChange,
    showProviderRouting,
}: ModelInfoViewProps) => {
    const providerRoutingId = useId()
    const isGemini = Object.keys(geminiModels).includes(selectedModelId)
    const contextTiers = modelInfo.capabilities?.contextWindowTiers ?? []

    // Capability checks
    const hasImages = supportsImages(modelInfo)
    const hasBrowser = supportsBrowserUse(modelInfo)
    // `undefined` when the model never declared caching; Gemini hides the row
    // entirely because this build carries no cache path for it.
    const hasCaching = isGemini ? false : supportsPromptCache(modelInfo)
    const hasNativeTools = modelInfo.capabilities?.supportsTools === true
    const hasReasoning =
        modelInfo.capabilities?.supportsReasoning === true || modelInfo.capabilities?.thinking?.supported === true

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
            <PricingEditor
                peakOffPeakLabels={peakOffPeakLabels}
                pricing={modelInfo.pricing}
                readOnly={true}
                showCachePrices={modelInfo.capabilities?.supportsPromptCache === true}
            />
        </div>
    )
}
