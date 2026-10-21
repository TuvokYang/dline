import type { UiMessage } from "../ExtensionMessage"

export interface ParsedMcpServerResponse {
    requestTs?: number
    responses: string[]
}

export function parseMcpServerResponse(text: string | undefined): ParsedMcpServerResponse {
    const fallback = { responses: [text || ""] }
    if (!text) return fallback
    try {
        const parsed = JSON.parse(text) as Partial<ParsedMcpServerResponse> & { type?: string }
        if (
            parsed.type === "mcp_server_response" &&
            typeof parsed.requestTs === "number" &&
            Array.isArray(parsed.responses) &&
            parsed.responses.every((response) => typeof response === "string")
        ) {
            return { requestTs: parsed.requestTs, responses: parsed.responses }
        }
    } catch {
        // Legacy rows persist the response as plain text.
    }
    return fallback
}

export function isMcpRequest(message: UiMessage): boolean {
    return message.ask === "use_mcp_server" || message.say === "use_mcp_server"
}

export function nearestPriorMcpRequestIndex(messages: readonly UiMessage[], responseIndex: number): number {
    for (let index = responseIndex - 1; index >= 0; index--) {
        if (isMcpRequest(messages[index])) return index
    }
    return -1
}

/** Whether an MCP response row is drawn inside its request's card rather than on its own. */
export function isAttachedMcpResponse(messages: readonly UiMessage[], responseIndex: number): boolean {
    const response = parseMcpServerResponse(messages[responseIndex]?.text)
    if (response.requestTs !== undefined) {
        if (messages.some((message) => message.ts === response.requestTs && isMcpRequest(message))) return true
    }
    return nearestPriorMcpRequestIndex(messages, responseIndex) !== -1
}
