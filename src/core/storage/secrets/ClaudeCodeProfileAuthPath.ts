import path from "node:path"

const PROFILE_AUTH_FILE_PATTERN = /^claude_code_oauth_(?:[A-Za-z0-9._~-]|%[A-F0-9]{2})+\.json$/

function requireProfileId(profileId: string): string {
	if (typeof profileId !== "string" || profileId.length === 0) {
		throw new Error("Claude Code OAuth credential requires a non-empty profile ID.")
	}
	return profileId
}

/**
 * Escape a Profile ID into a deterministic, traversal-safe file-name suffix.
 *
 * `encodeURIComponent` leaves a few sub-delimiters unescaped, so they are
 * percent-encoded explicitly to keep the produced name inside the pattern the
 * garbage collector matches.
 */
function encodeProfileId(profileId: string): string {
	return encodeURIComponent(requireProfileId(profileId)).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	)
}

export function getClaudeCodeProfileAuthFileName(profileId: string): string {
	return `claude_code_oauth_${encodeProfileId(profileId)}.json`
}

export function getClaudeCodeProfileAuthPath(secretsDir: string, profileId: string): string {
	return path.join(path.resolve(secretsDir), getClaudeCodeProfileAuthFileName(profileId))
}

export function isClaudeCodeProfileAuthFileName(fileName: string): boolean {
	return PROFILE_AUTH_FILE_PATTERN.test(fileName)
}
