import { describe, expect, it } from "vitest"
import { FALLBACK_SOURCE_REF, resolveSourceRef } from "../../scripts/source-revision.mjs"

type GitAnswers = Record<string, string | null>

/** Fake git that answers by joined argument list; unknown commands fail like a missing repository. */
function fakeGit(answers: GitAnswers) {
	return (args: string[]) => answers[args.join(" ")] ?? null
}

const LOCAL_BRANCH: GitAnswers = { "rev-parse --abbrev-ref HEAD": "feature/x", "rev-parse HEAD": "abc123" }
const DETACHED: GitAnswers = { "rev-parse --abbrev-ref HEAD": "HEAD", "rev-parse HEAD": "abc123" }

describe("resolveSourceRef", () => {
	it("prefers an explicit DLINE_SOURCE_REF over everything else", () => {
		const env = { DLINE_SOURCE_REF: "v9.9.9", GITHUB_REF_NAME: "dev", GITHUB_REF_TYPE: "branch" }
		expect(resolveSourceRef(env, fakeGit(LOCAL_BRANCH))).toBe("v9.9.9")
	})

	it("uses the pull request source branch instead of the synthetic merge ref", () => {
		const env = { GITHUB_HEAD_REF: "bugfix/y", GITHUB_REF_NAME: "42/merge", GITHUB_REF_TYPE: "branch" }
		expect(resolveSourceRef(env, fakeGit(DETACHED))).toBe("bugfix/y")
	})

	it("follows the branch or tag that triggered a GitHub Actions run", () => {
		expect(resolveSourceRef({ GITHUB_REF_NAME: "dev", GITHUB_REF_TYPE: "branch" }, fakeGit(DETACHED))).toBe("dev")
		expect(resolveSourceRef({ GITHUB_REF_NAME: "v0.10.0", GITHUB_REF_TYPE: "tag" }, fakeGit(DETACHED))).toBe("v0.10.0")
	})

	it("follows the local branch outside CI", () => {
		expect(resolveSourceRef({}, fakeGit(LOCAL_BRANCH))).toBe("feature/x")
	})

	it("pins a detached checkout to its commit", () => {
		expect(resolveSourceRef({}, fakeGit(DETACHED))).toBe("abc123")
	})

	it("falls back to the default-branch alias only when git cannot name the revision", () => {
		expect(resolveSourceRef({}, fakeGit({}))).toBe(FALLBACK_SOURCE_REF)
		expect(FALLBACK_SOURCE_REF).not.toBe("main")
	})
})
