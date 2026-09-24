/**
 * Text that must never reach the published site: retired Mintlify runtime,
 * unapproved tracking and third-party font services, and stale upstream
 * service URLs. Shared by the source check and the built-artifact check.
 */
export const FORBIDDEN_TEXT = Object.freeze([
	{ pattern: /mintlify/i, reason: "Mintlify runtime reference" },
	{ pattern: /hubspot|hs-scripts\.com/i, reason: "HubSpot tracking" },
	{ pattern: /fonts\.(?:googleapis|gstatic)\.com/i, reason: "Google Fonts request" },
	{ pattern: /googletagmanager\.com|google-analytics\.com/i, reason: "unapproved analytics" },
	{ pattern: /\bcline\.bot\b/i, reason: "stale upstream Cline service URL" },
])

/**
 * Return the first forbidden match in `text`, if any.
 * @param {string} text
 * @returns {{ index: number, reason: string } | undefined}
 */
export function findForbiddenText(text) {
	for (const { pattern, reason } of FORBIDDEN_TEXT) {
		const match = pattern.exec(text)
		if (match) {
			return { index: match.index, reason }
		}
	}
	return undefined
}
