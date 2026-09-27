import { StateServiceClient } from "@/services/grpc-client"

export type WebviewErrorKind = "render" | "uncaught" | "unhandled_rejection"

const MAX_REPORTS_PER_SESSION = 20
const MAX_MESSAGE_LENGTH = 1_000
const MAX_STACK_LENGTH = 4_000

const reportedSignatures = new Set<string>()
let reportCount = 0
let globalHandlersInstalled = false

/**
 * Forward a Webview failure to the extension so it reaches runtime telemetry.
 *
 * Reporting is best effort: a broken transport must never turn an error report
 * into a second error, and a render loop must not flood the extension, so
 * duplicates are dropped and each session is capped.
 */
export function reportWebviewError(kind: WebviewErrorKind, error: unknown, componentStack?: string): void {
	const normalized = normalizeError(error)
	const signature = `${kind}|${normalized.name}|${normalized.message}`
	if (reportedSignatures.has(signature) || reportCount >= MAX_REPORTS_PER_SESSION) return
	reportedSignatures.add(signature)
	reportCount += 1
	try {
		void StateServiceClient.reportWebviewError({
			kind,
			message: normalized.message.slice(0, MAX_MESSAGE_LENGTH),
			name: normalized.name,
			stack: normalized.stack?.slice(0, MAX_STACK_LENGTH),
			componentStack: componentStack?.slice(0, MAX_STACK_LENGTH),
		}).catch(() => undefined)
	} catch {
		// The transport itself may be the failing component.
	}
}

/** Install window-level handlers once so errors outside React rendering are reported too. */
export function installGlobalWebviewErrorReporting(): void {
	if (globalHandlersInstalled) return
	globalHandlersInstalled = true
	window.addEventListener("error", (event) => reportWebviewError("uncaught", event.error ?? event.message))
	window.addEventListener("unhandledrejection", (event) => reportWebviewError("unhandled_rejection", event.reason))
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
	if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
	return { name: "NonError", message: typeof error === "string" ? error : safeStringify(error) }
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}
