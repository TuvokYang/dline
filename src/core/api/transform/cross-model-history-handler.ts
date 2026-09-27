import { projectCrossModelHistory } from "@shared/messages/cross-model-history"
import type { ApiHandler } from "../index"

/**
 * Project stored history for the model this handler actually sends to.
 *
 * Replaces `createMessage` in place, like `instrumentApiHandler`, so handler identity, `ctx`, and
 * optional methods stay intact. The target model is read per request because some handlers only
 * resolve their model when the first request starts.
 */
export function withCrossModelHistory(handler: ApiHandler): ApiHandler {
	const send = handler.createMessage.bind(handler)
	handler.createMessage = (systemPrompt, messages, tools, options) =>
		send(systemPrompt, projectCrossModelHistory(messages, handler.getModel().id), tools, options)
	return handler
}
