/**
 * Source revision a build is compiled from.
 *
 * Links shipped inside a build (for example the What's New changelog link) must
 * point at the revision that build came from: an Insiders build from `dev` shows
 * the `dev` changelog, a production build from a release tag shows that tag.
 * Hard-coding a branch such as `main` would show another revision's content.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** Ref used when neither the environment nor git can name the revision; GitHub resolves it to the default branch. */
export const FALLBACK_SOURCE_REF = "HEAD"

/**
 * Pick the ref a build is compiled from.
 *
 * Precedence: an explicit `DLINE_SOURCE_REF`, the pull request source branch,
 * the branch or tag that triggered a GitHub Actions run, the local branch, the
 * local commit, and finally {@link FALLBACK_SOURCE_REF}.
 *
 * @param {Record<string, string | undefined>} env Process environment.
 * @param {(args: string[]) => string | null} readGit Runs `git` with `args` and returns trimmed stdout, or null on failure.
 * @returns {string} Branch, tag, or commit.
 */
export function resolveSourceRef(env, readGit) {
	const explicit = env.DLINE_SOURCE_REF?.trim()
	if (explicit) return explicit

	// A pull request run checks out a synthetic merge ref (`<n>/merge`) that has no
	// page on GitHub; the source branch does.
	const pullRequestBranch = env.GITHUB_HEAD_REF?.trim()
	if (pullRequestBranch) return pullRequestBranch

	const actionsRef = env.GITHUB_REF_NAME?.trim()
	if (actionsRef && (env.GITHUB_REF_TYPE === "branch" || env.GITHUB_REF_TYPE === "tag")) return actionsRef

	const branch = readGit(["rev-parse", "--abbrev-ref", "HEAD"])
	if (branch && branch !== "HEAD") return branch

	return readGit(["rev-parse", "HEAD"]) || FALLBACK_SOURCE_REF
}

/**
 * Run git in `cwd` and return trimmed stdout, or null when git is unavailable or fails.
 *
 * @param {string} cwd
 * @returns {(args: string[]) => string | null}
 */
export function gitReader(cwd) {
	return (args) => {
		try {
			return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null
		} catch {
			return null
		}
	}
}

/**
 * Repository web URL declared by a package manifest, without `git+` or `.git`.
 *
 * @param {string} packageJsonPath
 * @returns {string}
 */
export function readRepositoryWebUrl(packageJsonPath) {
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
	const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
	if (!url) throw new Error(`${packageJsonPath} declares no repository URL.`)
	return url
		.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
}
