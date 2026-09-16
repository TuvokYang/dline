import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect, test } from "@playwright/test"
import { getOpenAiCodexProfileAuthFileName } from "../../core/storage/secrets/OpenAiCodexProfileAuthPath"
import { SETTINGS_MIGRATION_VERSION, SETTINGS_MIGRATION_VERSION_KEY } from "../../core/storage/settings/settings-types"
import { E2E_PROFILE_NAMES, prepareE2EState } from "./utils/api-profile"

interface PreparedProfile {
	name: string
	provider?: string
	baseUrl?: string
	deepseek?: { apiFormat?: string; reasoning?: { effort?: string } }
	openai?: { apiFormat?: string; customModelEnabled?: boolean; reasoning?: { effort?: string } }
}

test("mock E2E profile preprocessing ignores local profiles, secrets, and live environment keys", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "dline-e2e-mock-profile-preprocess-"))
	const sourceDataDir = path.join(root, "source", "data")
	const dlineDir = path.join(root, "isolated")
	const staleProfileId = "stale-codex-profile"
	const sourceProfileId = "source-codex-profile"
	const staleToken = randomUUID()
	const sourceToken = randomUUID()

	try {
		await Promise.all([
			writeJson(path.join(dlineDir, "data", "settings", "api_profiles.json"), [
				{
					id: "stale-real-profile",
					name: "Stale Real Profile",
					provider: "deepseek",
					modelId: "stale-real-model",
					usedFor: ["act"],
					enabled: true,
				},
			]),
			writeJson(path.join(dlineDir, "data", "secrets", "api_keys.json"), {
				"stale-real-profile": { apiKey: "stale-real-secret", name: "Stale Real Profile" },
			}),
			writeJson(path.join(dlineDir, "data", "secrets", "provider_secrets.json"), {
				"stale-real-profile": {
					name: "Stale Real Profile",
					provider: "deepseek",
					secrets: { token: "stale-provider-secret" },
				},
			}),
			writeJson(path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(staleProfileId)), {
				access_token: staleToken,
				refresh_token: randomUUID(),
				expires: 1_900_000_000_000,
			}),
			writeJson(path.join(sourceDataDir, "settings", "api_profiles.json"), [
				{
					id: "must-not-copy-profile",
					name: "Must Not Copy Profile",
					provider: "deepseek",
					modelId: "must-not-copy-model",
					usedFor: ["act"],
					enabled: true,
				},
				{
					id: sourceProfileId,
					name: "Must Not Copy Codex Profile",
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
					usedFor: ["act"],
					enabled: true,
				},
			]),
			writeJson(path.join(sourceDataDir, "secrets", "api_keys.json"), {
				"must-not-copy-profile": { apiKey: "must-not-copy-secret", name: "Must Not Copy Profile" },
			}),
			writeJson(path.join(sourceDataDir, "secrets", getOpenAiCodexProfileAuthFileName(sourceProfileId)), {
				access_token: sourceToken,
				refresh_token: randomUUID(),
				expires: 1_900_000_000_000,
			}),
			writeJson(path.join(sourceDataDir, "secrets", "provider_secrets.json"), {
				"must-not-copy-profile": {
					name: "Must Not Copy Profile",
					provider: "deepseek",
					secrets: { token: "must-not-copy-provider-secret" },
				},
			}),
		])

		const result = await prepareE2EState({
			dlineDir,
			mockBaseUrl: "http://127.0.0.1:43210",
			sourceDataDir,
			env: { API_KEY_DEEPSEEK_DEEPSEEK_V4_PRO: "must-not-copy-environment-key" },
		})

		expect(result.selectedProfileName).toBe(E2E_PROFILE_NAMES.mockOpenAi)
		expect(result.localProfileNames).toEqual([])
		expect(result.liveProfiles).toEqual([])
		expect(result.profileNames).toEqual(expect.arrayContaining(Object.values(E2E_PROFILE_NAMES)))
		expect(result.profileNames).not.toContain("Must Not Copy Profile")
		expect(result.profileNames).not.toContain("Must Not Copy Codex Profile")
		expect(result.profileNames).not.toContain("Stale Real Profile")
		expect(result.profileNames).not.toContain("deepseek:deepseek-v4-pro")

		const apiKeys = await readJson<Record<string, { apiKey: string; name: string }>>(
			path.join(dlineDir, "data", "secrets", "api_keys.json"),
		)
		expect(Object.values(apiKeys)).toHaveLength(Object.values(E2E_PROFILE_NAMES).length)
		expect(Object.values(apiKeys).every(({ apiKey }) => apiKey === "dline-e2e-api-key")).toBe(true)
		expect(Object.values(apiKeys).map(({ name }) => name)).toEqual(expect.arrayContaining(Object.values(E2E_PROFILE_NAMES)))
		expect(await readdir(path.join(dlineDir, "data", "secrets"))).toEqual(["api_keys.json"])
		await expect(
			readFile(path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(staleProfileId)), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" })
		await expect(
			readFile(path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(sourceProfileId)), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" })
		await expect(readFile(path.join(dlineDir, "data", "secrets", "provider_secrets.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
	}
})

test("live E2E profile preprocessing copies only api_profiles.json and secrets/**", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "dline-e2e-profile-preprocess-"))
	const sourceDataDir = path.join(root, "source", "data")
	const dlineDir = path.join(root, "isolated")
	const codexProfileId = "local-codex-profile"
	const codexAccessToken = randomUUID()
	const codexRefreshToken = randomUUID()

	try {
		await Promise.all([
			writeJson(path.join(sourceDataDir, "settings", "api_profiles.json"), [
				{
					id: "local-profile",
					name: "Local Profile",
					provider: "deepseek",
					modelId: "local-model",
					usedFor: ["act", "plan"],
					enabled: true,
				},
				{
					id: codexProfileId,
					name: "Local Codex Profile",
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
					usedFor: ["act"],
					enabled: true,
				},
			]),
			writeJson(path.join(sourceDataDir, "settings", "settings.json"), {
				actModeProfile: "Local Profile",
				planModeProfile: "Local Profile",
				mustNotCopy: true,
			}),
			writeJson(path.join(sourceDataDir, "secrets", "api_keys.json"), {
				"local-profile": { apiKey: "local-secret", name: "Local Profile" },
			}),
			writeJson(path.join(sourceDataDir, "secrets", getOpenAiCodexProfileAuthFileName(codexProfileId)), {
				access_token: codexAccessToken,
				refresh_token: codexRefreshToken,
				expires: 1_900_000_000_000,
				accountId: "local-codex-account",
			}),
			writeJson(path.join(sourceDataDir, "secrets", "openai_codex_oauth.json"), {
				access_token: randomUUID(),
				refresh_token: randomUUID(),
				expires: 1_900_000_000_000,
			}),
			writeJson(path.join(sourceDataDir, "secrets", "must-not-copy.json"), { token: randomUUID() }),
			writeJson(path.join(sourceDataDir, "secrets", "provider_secrets.json"), {
				"local-profile": { name: "Local Profile", provider: "deepseek", secrets: { custom: "provider-secret" } },
			}),
			writeJson(path.join(sourceDataDir, "secrets.json"), { "openai-codex-oauth-credentials": "local-oauth" }),
			writeJson(path.join(sourceDataDir, "globalState.json"), { taskHistory: ["must-not-copy"] }),
		])

		const result = await prepareE2EState({
			dlineDir,
			mockBaseUrl: "http://127.0.0.1:43210",
			sourceDataDir,
			profileMode: "live",
			env: {
				API_KEY_DEEPSEEK_DEEPSEEK_V4_PRO: "ci-deepseek-key",
				API_KEY_OPENAI_CUSTOM_MODEL: "ci-compatible-key",
			},
		})

		expect(result.selectedProfileName).toBe(E2E_PROFILE_NAMES.mockOpenAi)
		expect(result.localProfileNames).toEqual(["Local Profile", "Local Codex Profile"])
		expect(result.liveProfiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					credentialSource: "local",
					profileId: "local-profile",
					profileName: "Local Profile",
					provider: "deepseek",
					modelId: "local-model",
				}),
				expect.objectContaining({
					credentialSource: "local",
					profileId: codexProfileId,
					profileName: "Local Codex Profile",
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
				}),
				expect.objectContaining({
					credentialSource: "environment",
					environmentVariable: "API_KEY_DEEPSEEK_DEEPSEEK_V4_PRO",
					profileName: "deepseek:deepseek-v4-pro",
					provider: "deepseek",
					modelId: "deepseek-v4-pro",
				}),
				expect.objectContaining({
					credentialSource: "environment",
					environmentVariable: "API_KEY_OPENAI_CUSTOM_MODEL",
					profileName: "openai:custom-model",
					provider: "openai",
					modelId: "custom-model",
				}),
			]),
		)
		expect(result.liveProfiles).toHaveLength(4)
		const profiles = await readJson<PreparedProfile[]>(path.join(dlineDir, "data", "settings", "api_profiles.json"))
		const deepseek = profiles.find((profile) => profile.name === "deepseek:deepseek-v4-pro")
		const compatible = profiles.find((profile) => profile.name === "openai:custom-model")
		expect(deepseek?.deepseek?.reasoning?.effort).toBe("high")
		expect(compatible?.openai?.reasoning?.effort).toBe("high")
		expect(compatible?.openai?.customModelEnabled).toBe(true)
		expect(profiles.some((profile) => profile.name === "Local Profile")).toBe(true)
		expect(profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)).toMatchObject({
			provider: "openai",
			baseUrl: "http://127.0.0.1:43210/mock/openai-compatible/chat/v1",
			openai: { apiFormat: "OPENAI_CHAT", customModelEnabled: true },
		})
		expect(profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)).toMatchObject({
			provider: "openai",
			baseUrl: "http://127.0.0.1:43210/mock/openai-compatible/responses/v1",
			openai: { apiFormat: "OPENAI_RESPONSES", customModelEnabled: true },
		})
		expect(profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)).toMatchObject({
			provider: "openai",
			baseUrl: "http://127.0.0.1:43210/mock/openai/official/v1",
			modelId: "gpt-5.4-mini",
			openai: { apiFormat: "OPENAI_RESPONSES", customModelEnabled: false },
		})
		expect(profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockAnthropic)).toMatchObject({
			provider: "anthropic",
			baseUrl: "http://127.0.0.1:43210/mock/anthropic",
		})

		const apiKeys = await readJson<Record<string, { apiKey: string }>>(
			path.join(dlineDir, "data", "secrets", "api_keys.json"),
		)
		expect(apiKeys["local-profile"].apiKey).toBe("local-secret")
		const deepseekLive = result.liveProfiles.find(
			(profile) => profile.credentialSource === "environment" && profile.provider === "deepseek",
		)
		const compatibleLive = result.liveProfiles.find(
			(profile) => profile.credentialSource === "environment" && profile.provider === "openai",
		)
		expect(apiKeys[deepseekLive!.profileId].apiKey).toBe("ci-deepseek-key")
		expect(apiKeys[compatibleLive!.profileId].apiKey).toBe("ci-compatible-key")
		expect(
			await readJson(path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(codexProfileId))),
		).toMatchObject({
			access_token: codexAccessToken,
			refresh_token: codexRefreshToken,
			accountId: "local-codex-account",
		})
		expect(await readJson(path.join(dlineDir, "data", "secrets", "provider_secrets.json"))).toMatchObject({
			"local-profile": { secrets: { custom: "provider-secret" } },
		})

		await expect(readFile(path.join(dlineDir, "data", "secrets", "openai_codex_oauth.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(readFile(path.join(dlineDir, "data", "secrets", "must-not-copy.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
		await expect(readFile(path.join(dlineDir, "data", "secrets.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

		const settings = await readJson<Record<string, unknown>>(path.join(dlineDir, "data", "settings", "settings.json"))
		expect(settings).toEqual({
			[SETTINGS_MIGRATION_VERSION_KEY]: SETTINGS_MIGRATION_VERSION,
			actModeProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planModeProfile: E2E_PROFILE_NAMES.mockOpenAi,
			imageGenerationEnabled: false,
			enableParallelToolCalling: true,
		})

		const globalState = await readJson<Record<string, unknown>>(path.join(dlineDir, "data", "globalState.json"))
		expect(globalState).toEqual({
			isNewUser: false,
			mode: "act",
			nativeToolCallEnabled: true,
			welcomeViewCompleted: true,
		})
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
	}
})

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, `${JSON.stringify(data)}\n`, "utf8")
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf8")) as T
}
