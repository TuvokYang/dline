import { Empty } from "@shared/proto/dline/common"
import type { WebviewErrorReport } from "@shared/proto/dline/state"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

const WEBVIEW_ERROR_KINDS = new Set(["render", "uncaught", "unhandled_rejection"])
const MAX_MESSAGE_LENGTH = 1_000
const MAX_STACK_LENGTH = 4_000

/**
 * Record a Webview-side failure in the extension log.
 *
 * The Webview has no telemetry pipeline of its own, so a render crash used to
 * leave an empty panel and no trace at all. Logging through `Logger.error`
 * routes the report into the existing `extension.error` telemetry stream.
 * Every field is re-bounded here because the Webview is not trusted to do it.
 */
export async function reportWebviewError(_controller: Controller, request: WebviewErrorReport): Promise<Empty> {
	const kind = WEBVIEW_ERROR_KINDS.has(request.kind) ? request.kind : "unknown"
	const error = new Error(truncate(request.message, MAX_MESSAGE_LENGTH) || "Unknown Webview error")
	error.name = `WebviewError(${kind})${request.name ? `:${truncate(request.name, 100)}` : ""}`
	error.stack = [
		`${error.name}: ${error.message}`,
		truncate(request.stack ?? "", MAX_STACK_LENGTH),
		request.componentStack ? `Component stack:${truncate(request.componentStack, MAX_STACK_LENGTH)}` : "",
	]
		.filter(Boolean)
		.join("\n")
	Logger.error(`[Webview] ${kind} error`, error)
	return Empty.create()
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}
