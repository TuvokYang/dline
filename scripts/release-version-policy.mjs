/**
 * Release version policy shared by every packaging channel.
 *
 * The VS Code Marketplace and Open VSX identify an extension version only by
 * its number; the pre-release track is a flag on that number. Production and
 * pre-release therefore split one version space by minor parity, as the VS Code
 * publishing guide recommends: production releases use even minors (0.10.z) and
 * pre-releases use odd minors (0.11.z), so a pre-release can never occupy a
 * number that a production release needs.
 *
 * Insiders is a separate extension. It follows the pre-release line's major and
 * minor and replaces the patch with a timestamp, so every Insiders build sorts
 * above the production release it is built after.
 */

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Parse a plain `major.minor.patch` version.
 *
 * @param {string} version Version to parse.
 * @returns {{ major: number, minor: number, patch: number }}
 * @throws {Error} When the version is not three numeric segments.
 */
export function parseReleaseVersion(version) {
	const match = RELEASE_VERSION_PATTERN.exec(version)
	if (!match) {
		throw new Error(`Version '${version}' is not a plain major.minor.patch number.`)
	}
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Whether a minor version belongs to the pre-release line.
 *
 * @param {number} minor Minor version segment.
 * @returns {boolean}
 */
export function isPreReleaseMinor(minor) {
	return minor % 2 === 1
}

/**
 * Reject a tagged release whose minor parity does not match its channel.
 *
 * @param {"production"|"pre-release"} channel Tagged release channel.
 * @param {string} version Version declared by the release tag.
 * @throws {Error} When the version is malformed or on the other channel's line.
 */
export function assertChannelVersion(channel, version) {
	const { minor } = parseReleaseVersion(version)
	if (channel === "production" && isPreReleaseMinor(minor)) {
		throw new Error(
			`Production version ${version} has an odd minor. Production releases use even minors; odd minors are reserved for pre-releases.`,
		)
	}
	if (channel === "pre-release" && !isPreReleaseMinor(minor)) {
		throw new Error(
			`Pre-release version ${version} has an even minor. Pre-releases use odd minors so they never occupy a production version.`,
		)
	}
}

/**
 * Create the Insiders version for the current package version.
 *
 * An odd package minor is already the pre-release line. An even package minor
 * is a production version being prepared or just released, whose pre-release
 * line is the next odd minor.
 *
 * @param {string} packageVersion Version currently in package.json.
 * @param {number} [nowMs] Current time in milliseconds; injectable for tests.
 * @returns {string}
 */
export function createInsidersVersion(packageVersion, nowMs = Date.now()) {
	const { major, minor } = parseReleaseVersion(packageVersion)
	const preReleaseMinor = isPreReleaseMinor(minor) ? minor : minor + 1
	return `${major}.${preReleaseMinor}.${Math.floor(nowMs / 1000)}`
}
