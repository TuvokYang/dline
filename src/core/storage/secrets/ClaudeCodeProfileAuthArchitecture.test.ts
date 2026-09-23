import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const secretsDirectory = path.dirname(fileURLToPath(new URL("./ClaudeCodeProfileAuthRepository.ts", import.meta.url)))
const sourceRoot = path.resolve(secretsDirectory, "../../..")

async function readSource(relativePath: string): Promise<string> {
	return fs.readFile(path.join(sourceRoot, relativePath), "utf8")
}

describe("Claude Code profile OAuth storage architecture", () => {
	it("keeps the credential out of the flat API key store and SecretStorage migration", async () => {
		const [providerKeys, stateMigrations] = await Promise.all([
			readSource("shared/storage/provider-keys.ts"),
			readSource("core/storage/state-migrations.ts"),
		])

		expect(providerKeys).not.toContain("claude-code-oauth-credentials")
		expect(stateMigrations).not.toContain("claude-code-oauth-credentials")
	})

	it("owns only profile-scoped credential files written owner-only", async () => {
		const [pathSource, repositorySource] = await Promise.all([
			fs.readFile(path.join(secretsDirectory, "ClaudeCodeProfileAuthPath.ts"), "utf8"),
			fs.readFile(path.join(secretsDirectory, "ClaudeCodeProfileAuthRepository.ts"), "utf8"),
		])
		const combined = `${pathSource}\n${repositorySource}`

		expect(combined).toContain("claude_code_oauth_")
		expect(combined).not.toContain("secrets.json")
		expect(combined).not.toContain("api_keys.json")
		expect(repositorySource).toContain("mode: 0o600")
		expect(repositorySource).toContain("fs.chmod(filePath, 0o600)")
	})

	it("keeps the OAuth strategy free of storage paths, StateManager, and telemetry", async () => {
		const strategySource = await readSource("integrations/anthropic-claude-code/oauth-strategy.ts")

		// The strategy owns protocol only; persistence belongs to the repository
		// and presentation belongs to the shared flow coordinator.
		expect(strategySource).not.toMatch(/secrets\.json|api_keys\.json|getDlineDataDir/)
		expect(strategySource).not.toMatch(/StateManager|ExtensionState|Telemetry|Logger\./)
		expect(strategySource).not.toContain("createServer(")
	})

	it("routes strategy traffic through the shared proxy-aware transport", async () => {
		const strategySource = await readSource("integrations/anthropic-claude-code/oauth-strategy.ts")

		expect(strategySource).toContain('from "@/shared/net"')
		// A bare global fetch would bypass proxy support and observability.
		expect(strategySource).not.toMatch(/(?<![.\w])fetch\(/)
	})
})
