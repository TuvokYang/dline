import { ApiHandler } from "@core/api"
import { findLastIndex } from "@shared/array"
import { showApprovalNotification } from "@/integrations/notifications"
import { calculateApiUsageStatistics } from "@/shared/api-usage"
import { UiApiReqCancelReason, UiApiReqInfo } from "@/shared/ExtensionMessage"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { MessageStateHandler } from "./message-state"

export const showNotificationForApproval = (message: string, notificationsEnabled: boolean) => {
    void showApprovalNotification({ message }, notificationsEnabled)
}

type UpdateApiReqMsgParams = {
    messageStateHandler: MessageStateHandler
    lastApiReqIndex: number
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    contextTokens: number
    /** Input of the attempt that produced the turn, when attempts were separated. */
    contextInputTokens?: number
    totalCost?: number
    cacheHitRate?: number
    api: ApiHandler
    cancelReason?: UiApiReqCancelReason
    streamingFailedMessage?: string
}

/**
 * Finalize persisted API request usage and pricing metadata.
 *
 * @param params Normalized request metrics and persistence dependencies.
 * @returns A promise that resolves after the request message is updated.
 */
export const updateApiReqMsg = async (params: UpdateApiReqMsgParams): Promise<void> => {
    const clineMessages = params.messageStateHandler.clineMessages
    const requestedMessage = clineMessages[params.lastApiReqIndex]
    const currentApiReqIndex =
        requestedMessage?.say === "api_req_started"
            ? params.lastApiReqIndex
            : findLastIndex(clineMessages, (message) => message.say === "api_req_started")
    if (currentApiReqIndex === -1) {
        throw new Error(
            `Unable to finalize API request message: no api_req_started message remains (requested index ${params.lastApiReqIndex})`,
        )
    }
    const currentApiReqInfo: UiApiReqInfo = JSON.parse(clineMessages[currentApiReqIndex].text || "{}")
    delete currentApiReqInfo.retryStatus // Clear retry status when request is finalized

    const modelInfo = params.api.getModel().info
    const { cacheHitRatePercent } = calculateApiUsageStatistics(params)
    const cacheHitRate = params.cacheHitRate ?? cacheHitRatePercent

    const hasReliableContextTokens = Number.isFinite(params.contextTokens) && params.contextTokens > 0
    const contextInputTokens = params.contextInputTokens
    await params.messageStateHandler.updateClineMessage(currentApiReqIndex, {
        text: JSON.stringify({
            ...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
            // Without measured occupancy the source still says so, so a reader never
            // falls back to the billing sum, which counts every retried attempt.
            ...(hasReliableContextTokens
                ? { contextTokens: params.contextTokens, contextTokensSource: "provider" as const }
                : { contextTokensSource: "estimate" as const }),
            ...(contextInputTokens !== undefined && Number.isFinite(contextInputTokens) && contextInputTokens >= 0
                ? { contextInputTokens }
                : {}),
            tokensIn: params.inputTokens,
            tokensOut: params.outputTokens,
            cacheWrites: params.cacheWriteTokens,
            cacheReads: params.cacheReadTokens,
            cost:
                params.totalCost ??
                calculateApiCostAnthropic(
                    modelInfo,
                    params.inputTokens,
                    params.outputTokens,
                    params.cacheWriteTokens,
                    params.cacheReadTokens,
                ),
            cacheHitRate: Math.round(cacheHitRate * 100) / 100, // Round to 2 decimal places
            currency: modelInfo.pricing?.currency || "USD",
            inputPrice: modelInfo.pricing?.inputPrice,
            outputPrice: modelInfo.pricing?.outputPrice,
            cancelReason: params.cancelReason,
            streamingFailedMessage: params.streamingFailedMessage,
        } satisfies UiApiReqInfo),
    })
}

/**
 * Extracts the domain from a provider URL string
 * @param url The URL to extract domain from
 * @returns The domain/hostname or undefined if invalid
 */
export function extractProviderDomainFromUrl(url: string | undefined): string | undefined {
    if (!url) {
        return undefined
    }
    try {
        const urlObj = new URL(url)
        return urlObj.hostname
    } catch {
        return undefined
    }
}
