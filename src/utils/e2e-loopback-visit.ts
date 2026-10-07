import { fetch } from "@shared/net"

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Upper bound for one visit; a mock OAuth server answers well inside it. */
export const E2E_LOOPBACK_VISIT_TIMEOUT_MS = 15_000

/**
 * Whether an external URL should be visited in-process instead of handed to a browser.
 *
 * E2E runs drive OAuth flows against loopback mock servers, and headless CI runners have no browser
 * that would follow the authorization redirect. The bypass applies only inside an E2E run and only
 * to plain-HTTP loopback destinations, so a stray `E2E_TEST` in a user's shell cannot make Dline
 * fetch a remote page instead of opening it.
 */
export function shouldVisitLoopbackUrlDirectly(url: string, env: NodeJS.ProcessEnv): boolean {
	if (env.E2E_TEST !== "true") return false
	try {
		const parsed = new URL(url)
		return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname)
	} catch {
		return false
	}
}

/**
 * Visit a loopback URL the way a browser would: follow redirects (which is how a mock authorization
 * server hands the code back to Dline's loopback callback) and consume the body so the connection closes.
 * Like a browser, an error status is a page the user would see, not a failure to open the URL, so the
 * final status is returned instead of thrown. Transport failures and timeouts reject.
 */
export async function visitLoopbackUrl(url: string, timeoutMs = E2E_LOOPBACK_VISIT_TIMEOUT_MS): Promise<number> {
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
	await response.arrayBuffer()
	return response.status
}
