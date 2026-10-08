import type { UiApiReqInfo, UiMessage } from "@shared/ExtensionMessage"

/**
 * Check if an API request is still active (streaming or executing tools).
 * Returns true when the api_req_started message has no cost, cancelReason,
 * or streamingFailedMessage — indicating the request hasn't completed yet.
 */
export function isApiReqActive(message: UiMessage | undefined): boolean {
	if (message?.type !== "say" || message.say !== "api_req_started") {
		return false
	}

	if (message.partial === true) {
		return true
	}

	if (!message.text) {
		return true
	}

	try {
		const info = JSON.parse(message.text) as UiApiReqInfo
		return info.cost == null && info.cancelReason == null && info.streamingFailedMessage == null
	} catch {
		return true
	}
}
