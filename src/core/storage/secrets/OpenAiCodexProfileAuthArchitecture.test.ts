import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const secretsDirectory = path.dirname(fileURLToPath(new URL("./OpenAiCodexProfileAuthRepository.ts", import.meta.url)))
const sourceRoot = path.resolve(secretsDirectory, "../../..")

async function readSource(relativePath: string): Promise<string> {
	return fs.readFile(path.join(sourceRoot, relativePath), "utf8")
}

describe("OpenAI Codex profile OAuth storage architecture", () => {
	it("does not map Codex OAuth into the flat API key store or SecretStorage migration", async () => {
		const [providerKeys, stateMigrations] = await Promise.all([
			readSource("shared/storage/provider-keys.ts"),
			readSource("core/storage/state-migrations.ts"),
		])

		expect(providerKeys).not.toContain('"openai-codex": "openai-codex-oauth-credentials"')
		expect(stateMigrations).not.toContain('context.secrets.get("openai-codex-oauth-credentials")')
	})

	it("uses only the dedicated legacy file and profile-owned files", async () => {
		const [pathSource, repositorySource, migrationSource] = await Promise.all([
			fs.readFile(path.join(secretsDirectory, "OpenAiCodexProfileAuthPath.ts"), "utf8"),
			fs.readFile(path.join(secretsDirectory, "OpenAiCodexProfileAuthRepository.ts"), "utf8"),
			fs.readFile(path.join(secretsDirectory, "OpenAiCodexProfileAuthMigration.ts"), "utf8"),
		])
		const combined = `${pathSource}\n${repositorySource}\n${migrationSource}`

		expect(combined).toContain("openai_codex_oauth.json")
		expect(combined).toContain("openai_codex_")
		expect(combined).not.toContain("secrets.json")
		expect(combined).not.toContain("api_keys.json")
		// Owner-only files published through the shared atomic writer.
		expect(repositorySource).toContain("CREDENTIAL_FILE_MODE = 0o600")
		expect(repositorySource).toContain("writeJsonAtomic(filePath, value, { mode: CREDENTIAL_FILE_MODE })")
		expect(migrationSource).toContain("writeJsonAtomic(filePath, marker, { mode: 0o600 })")
	})
})
