import type { ClineStorageMessage } from "@shared/messages/content"
import { projectInternalMessagesForProvider } from "@shared/messages/content"
import type { PreparedProviderRequest } from "./ProviderRequest"

/**
 * Shape the canonical history for the endpoint this request targets.
 *
 * Hosted tool blocks replay only to the protocol that produced them, and
 * attached PDFs become native documents only within the endpoint's document
 * budget; every other PDF is sent as its extracted text.
 */
export function projectForEndpoint(request: PreparedProviderRequest, messages: ClineStorageMessage[]): ClineStorageMessage[] {
    return projectInternalMessagesForProvider(messages, {
        hostedToolReplayProtocol: request.api.getHostedToolReplayProtocol?.(),
        documentInput: request.api.getDocumentInputLimits?.(),
    })
}
