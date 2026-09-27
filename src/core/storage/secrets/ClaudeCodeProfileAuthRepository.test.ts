import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getClaudeCodeProfileAuthFileName, getClaudeCodeProfileAuthPath } from "./ClaudeCodeProfileAuthPath"
import {
	type ClaudeCodeOAuthCredentials,
	ClaudeCodeProfileAuthRepository,
	parseClaudeCodeOAuthCredentials,
} from "./ClaudeCodeProfileAuthRepository"

const EXPIRES = 1_800_000_000_000

function credentials(owner: string): ClaudeCodeOAuthCredentials {
	return {
		type: "claude-code",
		access_token: `${owner}-access`,
		refresh_token: `${owner}-refresh`,
		expires: EXPIRES,
		email: `${owner}@example.test`,
	}
}

describe("ClaudeCodeProfileAuthRepository", () => {
	let root: string
	let secretsDir: string
	let repository: ClaudeCodeProfileAuthRepository

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-claude-code-auth-"))
		secretsDir = path.join(root, "data", "secrets")
		repository = new ClaudeCodeProfileAuthRepository({ secretsDir })
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("uses the escaped Profile ID as a deterministic traversal-safe file suffix", () => {
		expect(getClaudeCodeProfileAuthFileName("profile-a")).toBe("claude_code_oauth_profile-a.json")
		expect(getClaudeCodeProfileAuthFileName("../../profile-a")).toBe("claude_code_oauth_..%2F..%2Fprofile-a.json")
		expect(path.dirname(getClaudeCodeProfileAuthPath(secretsDir, "../../profile-a"))).toBe(path.resolve(secretsDir))
	})

	it("keeps each Profile credential in its own document", async () => {
		await repository.save("profile-a", credentials("a"))
		await repository.save("profile-b", credentials("b"))

		await expect(repository.read("profile-a")).resolves.toEqual({ status: "valid", credential: credentials("a") })
		await expect(repository.read("profile-b")).resolves.toEqual({ status: "valid", credential: credentials("b") })
	})

	it("reports a missing credential rather than throwing", async () => {
		await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
	})

	it("reports a malformed document instead of surfacing it as a usable credential", async () => {
		await fs.mkdir(secretsDir, { recursive: true })
		await fs.writeFile(repository.filePath("profile-a"), "{ not json", "utf8")

		await expect(repository.read("profile-a")).resolves.toEqual({ status: "malformed" })
	})

	// Windows does not model POSIX permission bits, so the owner-only contract
	// can only be asserted on POSIX hosts.
	it.skipIf(process.platform === "win32")("writes the credential document owner-only", async () => {
		await repository.save("profile-a", credentials("a"))

		expect((await fs.stat(repository.filePath("profile-a"))).mode & 0o777).toBe(0o600)
	})

	it("preserves fields written by a newer client when rewriting a credential", async () => {
		await fs.mkdir(secretsDir, { recursive: true })
		await fs.writeFile(
			repository.filePath("profile-a"),
			JSON.stringify({ ...credentials("a"), futureField: "keep-me" }),
			"utf8",
		)

		await repository.save("profile-a", { ...credentials("a"), access_token: "rotated-access" })

		const stored = JSON.parse(await fs.readFile(repository.filePath("profile-a"), "utf8"))
		expect(stored).toMatchObject({ futureField: "keep-me", access_token: "rotated-access" })
	})

	it("replaces a credential only while the stored document still matches", async () => {
		await repository.save("profile-a", credentials("a"))
		const rotated = { ...credentials("a"), access_token: "rotated-access" }

		await expect(repository.replaceIfMatches("profile-a", credentials("a"), rotated)).resolves.toBe("saved")
		// A second refresh started from the stale copy must not clobber the newer token.
		await expect(repository.replaceIfMatches("profile-a", credentials("a"), rotated)).resolves.toBe("changed")
		await expect(repository.read("profile-a")).resolves.toEqual({ status: "valid", credential: rotated })
	})

	it("deletes a credential only while the stored document still matches", async () => {
		await repository.save("profile-a", credentials("a"))

		await expect(repository.deleteIfMatches("profile-a", credentials("b"))).resolves.toBe("changed")
		await expect(repository.deleteIfMatches("profile-a", credentials("a"))).resolves.toBe("deleted")
		await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
	})

	it("deletes one Profile credential without touching another", async () => {
		await repository.save("profile-a", credentials("a"))
		await repository.save("profile-b", credentials("b"))

		await repository.delete("profile-a")

		await expect(repository.read("profile-a")).resolves.toEqual({ status: "missing" })
		await expect(repository.read("profile-b")).resolves.toEqual({ status: "valid", credential: credentials("b") })
	})

	it("rejects a credential without a usable access token or expiry", () => {
		expect(() => parseClaudeCodeOAuthCredentials({ expires: EXPIRES })).toThrowError(/access_token/)
		expect(() => parseClaudeCodeOAuthCredentials({ access_token: "a", expires: 1 })).toThrowError(/expires/)
		expect(() => parseClaudeCodeOAuthCredentials({ access_token: "a", expires: EXPIRES, refresh_token: "" })).toThrowError(
			/refresh_token/,
		)
	})

	it("accepts an access-only credential that cannot be refreshed", () => {
		expect(parseClaudeCodeOAuthCredentials({ access_token: "a", expires: EXPIRES })).toEqual({
			access_token: "a",
			expires: EXPIRES,
		})
	})
})
