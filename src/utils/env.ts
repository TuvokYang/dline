import { EmptyRequest, StringRequest } from "@shared/proto/dline/common"
import { ShowMessageType } from "@shared/proto/dline/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { shouldVisitLoopbackUrlDirectly, visitLoopbackUrl } from "@/utils/e2e-loopback-visit"

/**
 * Writes text to the system clipboard
 * @param text The text to write to the clipboard
 * @returns Promise that resolves when the operation is complete
 * @throws Error if the operation fails
 */
export async function writeTextToClipboard(text: string): Promise<void> {
	try {
		await HostProvider.env.clipboardWriteText(StringRequest.create({ value: text }))
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to write to clipboard: ${errorMessage}`)
	}
}

/**
 * Reads text from the system clipboard
 * @returns Promise that resolves to the clipboard text
 * @throws Error if the operation fails
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const response = await HostProvider.env.clipboardReadText(EmptyRequest.create({}))
		return response.value
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to read from clipboard: ${errorMessage}`)
	}
}

export function redactExternalUrl(value: string): string {
	try {
		const url = new URL(value)
		return `${url.protocol}//${url.host}${url.pathname}`
	} catch {
		return "<invalid-url>"
	}
}

/**
 * Opens an external URL in the default browser.
 * Uses the host bridge RPC first (VS Code's openExternal which handles remote environments).
 * Falls back to the `open` npm package if the host doesn't implement the RPC (e.g., JetBrains).
 * @param url The URL to open
 * @returns Promise that resolves when the operation is complete
 */
export async function openExternal(url: string): Promise<void> {
	Logger.log("Opening external URL:", redactExternalUrl(url))
	if (shouldVisitLoopbackUrlDirectly(url, process.env)) {
		// A browser opens asynchronously; callers such as OAuth flows must not wait for the page to load.
		void visitLoopbackUrlForE2E(url)
		return
	}
	try {
		await HostProvider.env.openExternal(StringRequest.create({ value: url }))
	} catch {
		// Fallback for hosts that don't implement openExternal (e.g., JetBrains plugin).
		Logger.warn("Host openExternal RPC failed; falling back to the local open package.")
		try {
			const open = (await import("open")).default
			await open(url)
		} catch {
			Logger.error("Fallback external URL opening failed.")
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to open the external URL.",
			})
		}
	}
}

/** Stands in for the browser of an E2E run; a failed visit behaves like a browser error page, not a thrown open. */
async function visitLoopbackUrlForE2E(url: string): Promise<void> {
	try {
		const status = await visitLoopbackUrl(url)
		Logger.log(`E2E loopback visit finished with HTTP ${status}:`, redactExternalUrl(url))
	} catch (error) {
		const reason = error instanceof Error ? error.name : "unknown"
		Logger.warn(`E2E loopback visit failed (${reason}):`, redactExternalUrl(url))
	}
}
