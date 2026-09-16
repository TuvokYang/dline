import { isSignalRecordingEnabled } from "@/services/telemetry/service/pipeline-port"
import { Logger } from "@/shared/services/Logger"
import type { ApiHandler, ApiHandlerContext } from "../index"
import type { ApiStream } from "../transform/stream"
import { ApiRequestObservation } from "./api-request-observation"
import { requestMetadata } from "./api-request-snapshot"

/** Preserve handler identity and optional methods; only wrap the owned generation/abort boundary. */
export function instrumentApiHandler(handler: ApiHandler, context: ApiHandlerContext): ApiHandler {
	const send = handler.createMessage.bind(handler)
	const abort = handler.abort?.bind(handler)
	const active = new Set<ApiRequestObservation>()

	handler.createMessage = (...args: Parameters<ApiHandler["createMessage"]>): ApiStream => {
		let stream: ApiStream | undefined
		const start = (): ApiStream => {
			if (!isSignalRecordingEnabled()) return send(...args)
			try {
				const [, messages, tools, options] = args
				const metadata = requestMetadata(handler, context, messages.length, tools?.length ?? 0, options)
				const observation = new ApiRequestObservation(metadata, options?.taskNamespace ?? context.ulid, () =>
					active.delete(observation),
				)
				active.add(observation)
				return observation.wrap(() => send(...args))
			} catch {
				Logger.debug("[ApiRequestObservation] Request metadata unavailable")
				return send(...args)
			}
		}
		let closedBeforeStart = false
		return {
			next: (...values: [] | [unknown]) => {
				if (closedBeforeStart) return Promise.resolve({ done: true, value: undefined })
				stream ??= start()
				return stream.next(...values)
			},
			return: (value: unknown) => {
				if (stream) return stream.return(value)
				closedBeforeStart = true
				return Promise.resolve({ done: true, value })
			},
			throw: (error: unknown) => {
				if (stream) return stream.throw(error)
				closedBeforeStart = true
				return Promise.reject(error)
			},
			async [Symbol.asyncDispose]() {
				if (stream) await stream.return(undefined)
				closedBeforeStart = true
			},
			[Symbol.asyncIterator]() {
				return this
			},
		}
	}
	if (abort) {
		handler.abort = () => {
			for (const observation of active) observation.cancel()
			abort()
		}
	}
	return handler
}
