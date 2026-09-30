import { EmptyRequest } from "@shared/proto/dline/common"
import { ClineMessage } from "@shared/proto/dline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Per-controller subscriptions to isolate partial messages between independent webviews.
const subs = new Map<Controller, Set<StreamingResponseHandler<ClineMessage>>>()

// Keep track of callback-based subscriptions (for CLI and other non-gRPC consumers).
// These remain global since CLI consumers are not per-controller.
export type PartialMessageCallback = (message: ClineMessage) => void
const callbackSubscriptions = new Set<PartialMessageCallback>()

/**
 * Subscribe to partial message events for a specific controller.
 */
export async function subscribeToPartialMessage(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<ClineMessage>,
	requestId?: string,
): Promise<void> {
	let set = subs.get(controller)
	if (!set) {
		set = new Set()
		subs.set(controller, set)
	}
	set.add(responseStream)

	const cleanup = () => {
		const s = subs.get(controller)
		if (s) {
			s.delete(responseStream)
			if (s.size === 0) subs.delete(controller)
		}
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "partial_message_subscription" }, responseStream)
	}
}

/**
 * Register a callback to receive partial message events (for CLI and non-gRPC consumers)
 * @param callback The callback function to receive messages
 * @returns A function to unsubscribe
 */
export function registerPartialMessageCallback(callback: PartialMessageCallback): () => void {
	callbackSubscriptions.add(callback)
	return () => {
		callbackSubscriptions.delete(callback)
	}
}

/**
 * Send a partial message event to a specific controller's subscribers.
 * @param controller The controller whose subscribers should receive the event
 * @param partialMessage The ClineMessage to send
 */
export async function sendPartialMessageEvent(
	controller: Controller,
	partialMessage: ClineMessage,
	owner: NonNullable<Controller["task"]>,
): Promise<void> {
	if (controller.task !== owner) return
	partialMessage = { ...partialMessage, taskId: owner.taskId, taskInstanceId: owner.taskInstanceId }
	// Send to gRPC stream subscribers of this controller
	const set = subs.get(controller)
	const streamPromises: Promise<void>[] = []
	if (set && set.size > 0) {
		for (const responseStream of set) {
			streamPromises.push(
				responseStream(partialMessage, false).catch((error) => {
					Logger.error("Error sending partial message event:", error)
					set.delete(responseStream)
				}),
			)
		}
	}

	// Await delivery so message order is deterministic — without this,
	// auto-approved tool partials can race ahead of a subsequent ask.
	if (streamPromises.length > 0) {
		await Promise.all(streamPromises)
	}

	// Send to callback subscribers (synchronous, global)
	for (const callback of callbackSubscriptions) {
		try {
			callback(partialMessage)
		} catch (error) {
			Logger.error("Error in partial message callback:", error)
		}
	}
}
