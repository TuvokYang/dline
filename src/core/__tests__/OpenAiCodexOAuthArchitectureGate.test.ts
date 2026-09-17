import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..", "..", "..")

async function source(relativePath: string): Promise<string> {
	return readFile(path.join(root, relativePath), "utf8")
}

describe("OpenAI Codex Profile OAuth architecture gate", () => {
	it("keeps provider-neutral OAuth infrastructure free of Codex dependencies", async () => {
		const oauthDir = path.join(root, "src", "services", "oauth")
		const files = (await readdir(oauthDir)).filter((entry) => entry.endsWith(".ts"))
		const combined = (await Promise.all(files.map((entry) => readFile(path.join(oauthDir, entry), "utf8")))).join("\n")

		expect(combined).not.toMatch(/openai[-_ ]codex/i)
		expect(combined).not.toContain("chatgpt.com")
	})

	it("removes the legacy global secret while permanently reserving its Proto identity", async () => {
		const [stateKeys, stateProto, generator] = await Promise.all([
			source("src/shared/storage/state-keys.ts"),
			source("proto/dline/state.proto"),
			source("scripts/generate-state-proto.mjs"),
		])

		expect(stateKeys).not.toContain('"openai-codex-oauth-credentials"')
		expect(stateProto).not.toMatch(/optional string openai_codex_oauth_credentials\s*=\s*48;/)
		expect(stateProto).toContain("reserved 48;")
		expect(stateProto).toContain('reserved "openai_codex_oauth_credentials";')
		expect(generator).toContain("openai_codex_oauth_credentials")
		expect(generator).toContain("reserved 48")
	})

	it("has no production global credential probe, legacy secrets.json path, or API-key OAuth UI", async () => {
		const [manager, provider, profileReader, providerUi, settingsE2E] = await Promise.all([
			source("src/integrations/openai-codex/oauth.ts"),
			source("src/core/api/providers/openai-codex.ts"),
			source("src/core/controller/file/getApiProfiles.ts"),
			source("webview-ui/src/components/settings/providers/OpenAiCodexProvider.tsx"),
			source("src/test/e2e/functional/profiles/settings-api-profiles.test.ts"),
		])
		const production = [manager, provider, profileReader, providerUi].join("\n")

		expect(production).not.toContain("openai-codex-oauth-credentials")
		expect(production).not.toMatch(/data[\\/]secrets\.json|secrets\.json.*openai.codex/i)
		expect(provider).not.toMatch(/getAccessToken\(|forceRefreshAccessToken\(|getAccountId\(/)
		expect(manager).not.toMatch(/async getAccessToken\(|async forceRefreshAccessToken\(|async getAccountId\(/)
		expect(providerUi).not.toContain("ApiKeyField")
		expect(providerUi).not.toMatch(/access token|refresh token|oauth json/i)
		expect(settingsE2E).not.toContain('"openai-codex": "OpenAI Codex API Key"')
	})

	it("does not log or surface complete external OAuth URLs", async () => {
		const external = await source("src/utils/env.ts")

		expect(external).not.toContain('Logger.log("Opening browser:", url)')
		expect(external).not.toContain("Failed to open URL: ${url}")
		expect(external).toContain("redactExternalUrl")
	})

	it("limits E2E endpoint overrides to the explicit loopback-only adapter", async () => {
		const [runtimeConfig, manager, provider] = await Promise.all([
			source("src/integrations/openai-codex/runtime-config.ts"),
			source("src/integrations/openai-codex/oauth.ts"),
			source("src/core/api/providers/openai-codex.ts"),
		])

		expect(runtimeConfig).toContain('env.E2E_TEST !== "true"')
		expect(runtimeConfig).toContain("loopback HTTP URL")
		expect(manager).toContain("resolveOpenAiCodexRuntimeConfig")
		expect(provider).toContain("resolveOpenAiCodexRuntimeConfig")
	})
})
