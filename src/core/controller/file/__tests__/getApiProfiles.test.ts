import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { getAllApiKeys, resetAllStores } from "@core/storage/secrets"
import { EmptyRequest } from "@shared/proto/dline/common"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { PROVIDER_OPTIONS } from "@shared/providers/providers"
import { Logger } from "@shared/services/Logger"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import {
	getApiProfiles,
	normalizeApiProfile,
	readApiProfiles,
	serializeApiProfilesForStorage,
	writeApiProfilesToFile,
} from "../getApiProfiles"
import { updateApiProfiles } from "../updateApiProfiles"

describe("getApiProfiles", () => {
	it("treats a legacy Profile without enabled as active", () => {
		const profile = normalizeApiProfile({
			id: "legacy-deepseek",
			name: "deepseek:deepseek-v4-pro:2",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
		})

		expect(profile.enabled).to.equal(true)
	})

	it("migrates legacy Anthropic 1M model ids to native 1M base models", () => {
		const profile = normalizeApiProfile({
			id: "legacy-anthropic-1m",
			name: "anthropic:claude-opus-4-7:1m",
			provider: "anthropic",
			modelId: "claude-opus-4-7:1m",
		})

		expect(profile.modelId).to.equal("claude-opus-4-7")
		expect(profile.anthropic?.enableLongContext).to.equal(undefined)
	})

	it("migrates retired Opus 4.6 fast ids to the supported standard model", () => {
		const profile = normalizeApiProfile({
			id: "legacy-anthropic-fast-1m",
			name: "anthropic:claude-opus-4-6:1m:fast",
			provider: "anthropic",
			modelId: "claude-opus-4-6:1m:fast",
		})

		expect(profile.modelId).to.equal("claude-opus-4-6")
		expect(profile.anthropic?.enableLongContext).to.equal(undefined)
	})

	it("does not migrate a legacy-looking custom Anthropic model id", () => {
		const profile = normalizeApiProfile({
			id: "custom-anthropic-1m",
			name: "anthropic:vendor-model:1m",
			provider: "anthropic",
			modelId: "vendor-model:1m",
		})

		expect(profile.modelId).to.equal("vendor-model:1m")
		expect(profile.anthropic?.enableLongContext).to.equal(undefined)
	})

	it("preserves a direct context override for a native-window Anthropic model", () => {
		const profile = normalizeApiProfile({
			id: "legacy-anthropic-window",
			name: "anthropic:claude-opus-4-7",
			provider: "anthropic",
			modelId: "claude-opus-4-7",
			anthropic: {
				enableLongContext: false,
				capabilities: { contextWindow: 180_000 },
			},
		})

		expect(profile.anthropic?.capabilities?.contextWindow).to.equal(180_000)
		expect(profile.anthropic?.capabilities?.contextWindowTiers).to.equal(undefined)
	})

	it("removes stale tiers while preserving a direct window for Anthropic models without tiers", () => {
		const profile = normalizeApiProfile({
			id: "native-anthropic-window",
			name: "anthropic:claude-opus-5",
			provider: "anthropic",
			modelId: "claude-opus-5",
			anthropic: {
				enableLongContext: true,
				capabilities: {
					contextWindow: 1_500_000,
					contextWindowTiers: [
						{ id: "standard", contextWindow: 200_000, label: "200K" },
						{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
					],
				},
			},
		})

		expect(profile.anthropic?.capabilities?.contextWindow).to.equal(1_500_000)
		expect(profile.anthropic?.capabilities?.contextWindowTiers).to.equal(undefined)
	})

	it("preserves explicit tiers for a custom Anthropic profile whose id matches a catalog model", () => {
		const contextWindowTiers = [
			{ id: "standard", contextWindow: 200_000, label: "200K", apiModelSuffix: undefined },
			{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: undefined },
		]
		const profile = normalizeApiProfile({
			id: "custom-anthropic-window",
			name: "Custom Anthropic Window",
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
			anthropic: {
				customModelEnabled: true,
				capabilities: { contextWindowTiers },
			},
		})

		expect(profile.anthropic?.capabilities?.contextWindowTiers).to.deep.equal(contextWindowTiers)
	})

	it("migrates a custom tiered Anthropic standalone window into the selected tier", () => {
		const profile = normalizeApiProfile({
			id: "custom-tiered-anthropic-window",
			name: "anthropic:vendor-tiered",
			provider: "anthropic",
			modelId: "vendor-tiered",
			anthropic: {
				enableLongContext: true,
				capabilities: {
					contextWindow: 1_400_000,
					contextWindowTiers: [
						{ id: "standard", contextWindow: 200_000, label: "200K" },
						{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
					],
				},
			},
		})

		expect(profile.anthropic?.capabilities?.contextWindow).to.equal(undefined)
		expect(profile.anthropic?.capabilities?.contextWindowTiers?.find((tier) => tier.id === "long")?.contextWindow).to.equal(
			1_400_000,
		)
	})

	it("persists an explicitly disabled Profile as disabled", () => {
		const stored = serializeApiProfilesForStorage([
			ApiProfile.create({
				id: "disabled-deepseek",
				name: "disabled-deepseek",
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
				enabled: false,
			}),
		]) as Array<Record<string, unknown>>

		expect(stored[0].enabled).to.equal(false)
	})

	it("clears local image bindings when a Profile selects Hosted", () => {
		const profile = normalizeApiProfile({
			id: "hosted-openai",
			name: "Hosted OpenAI",
			provider: "openai",
			modelId: "gpt-5.4-mini",
			usedFor: ["act"],
			imageSource: "IMAGE_GENERATION_SOURCE_HOSTED",
			imageProfileId: "stale-independent-profile",
			imageModelId: "gpt-image-2",
		})

		expect(profile.imageSource).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED)
		expect(profile.imageProfileId).to.equal(undefined)
		expect(profile.imageModelId).to.equal(undefined)
	})

	it("preserves an explicit None image source and clears stale image bindings", () => {
		const profile = normalizeApiProfile({
			id: "none-openai",
			name: "None OpenAI",
			provider: "openai",
			modelId: "gpt-5.4-mini",
			imageSource: "IMAGE_GENERATION_SOURCE_UNSPECIFIED",
			imageProfileId: "stale-independent-profile",
			imageModelId: "gpt-image-2",
		})

		expect(profile.imageSource).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED)
		expect(profile.imageProfileId).to.equal(undefined)
		expect(profile.imageModelId).to.equal(undefined)
	})

	it("migrates a legacy missing image source with an image model binding to Current", () => {
		const profile = normalizeApiProfile({
			id: "legacy-current-openai",
			name: "Legacy Current OpenAI",
			provider: "openai",
			modelId: "gpt-5.4-mini",
			imageModelId: "gpt-image-2",
		})

		expect(profile.imageSource).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION)
		expect(profile.imageModelId).to.equal("gpt-image-2")
	})

	it("preserves an explicit Current source and selected image model", () => {
		const profile = normalizeApiProfile({
			id: "current-openai",
			name: "Current OpenAI",
			provider: "openai",
			modelId: "gpt-5.4-mini",
			imageSource: "IMAGE_GENERATION_SOURCE_CURRENT",
			imageModelId: "gpt-image-1",
		})

		expect(profile.imageSource).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION)
		expect(profile.imageModelId).to.equal("gpt-image-1")
		expect(profile.imageProfileId).to.equal(undefined)
	})

	it("migrates the legacy subscription alias to the shared gpt-image-2.5 default", () => {
		const profile = normalizeApiProfile({
			id: "legacy-subscription-alias",
			name: "Legacy Subscription Alias",
			provider: "openai-codex",
			modelId: "gpt-5",
			imageSource: "IMAGE_GENERATION_SOURCE_CURRENT",
			imageModelId: "gpt-image-2-sub",
		})

		expect(profile.imageSource).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION)
		expect(profile.imageModelId).to.equal("gpt-image-2.5")
		expect(profile.schemaVersion).to.equal(2)
	})

	it("keeps a legacy missing image source without image bindings as None", () => {
		const profile = normalizeApiProfile({
			id: "legacy-none-anthropic",
			name: "Legacy None Anthropic",
			provider: "anthropic",
			modelId: "claude-chat",
		})

		expect(profile.imageSource).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED)
		expect(profile.imageProfileId).to.equal(undefined)
		expect(profile.imageModelId).to.equal(undefined)
	})

	it("reads an empty legacy capabilities.tools as no statement about the switches", () => {
		// Older builds wrote `[]` as their plain default, so it cannot be told
		// apart from a deliberate "turn everything off". Reading it as one pinned
		// hosted-capable models to the local route with nothing in the UI to undo.
		const profile = normalizeApiProfile({
			id: "legacy-tools-anthropic",
			name: "Legacy Tools Anthropic",
			provider: "anthropic",
			modelId: "claude-opus-5",
			anthropic: { capabilities: { contextWindow: 200_000, tools: [] } },
		})

		expect(profile.anthropic?.capabilities).to.not.have.property("tools")
		expect(profile.anthropic?.disabledServerTools).to.deep.equal([])
	})

	it("keeps a legacy override that left hosted search on as no disabled tools", () => {
		const profile = normalizeApiProfile({
			id: "legacy-tools-enabled-anthropic",
			name: "Legacy Tools Enabled Anthropic",
			provider: "anthropic",
			modelId: "claude-opus-5",
			anthropic: { capabilities: { contextWindow: 200_000, tools: ["WEB_SEARCH"] } },
		})

		expect(profile.anthropic?.capabilities).to.not.have.property("tools")
		expect(profile.anthropic?.disabledServerTools).to.deep.equal([])
	})

	it("clears hosted tool disables the earlier misreading already stored", () => {
		// The legacy declaration is gone by now: a previous run stripped it and
		// left only the disable list it wrongly inferred.
		const profile = normalizeApiProfile({
			id: "already-migrated-anthropic",
			name: "Already Migrated Anthropic",
			provider: "anthropic",
			modelId: "claude-opus-5",
			anthropic: { capabilities: { contextWindow: 200_000 }, disabledServerTools: ["WEB_SEARCH"] },
		})

		expect(profile.anthropic?.disabledServerTools).to.deep.equal([])
		expect(profile.schemaVersion).to.equal(2)
	})

	it("keeps hosted tool disables chosen after the reset", () => {
		const profile = normalizeApiProfile({
			id: "current-revision-anthropic",
			name: "Current Revision Anthropic",
			provider: "anthropic",
			modelId: "claude-opus-5",
			schemaVersion: 1,
			anthropic: { capabilities: { contextWindow: 200_000 }, disabledServerTools: ["WEB_SEARCH"] },
		})

		expect(profile.anthropic?.disabledServerTools).to.deep.equal([ServerTool.WEB_SEARCH])
		expect(profile.schemaVersion).to.equal(2)
	})

	it("persists historical Profile names for name-only Task migration", () => {
		const stored = serializeApiProfilesForStorage([
			ApiProfile.create({
				id: "renamed-profile",
				name: "Current Name",
				legacyNames: ["Previous Name", "Original Name"],
				enabled: true,
			}),
		]) as Array<Record<string, unknown>>

		expect(stored[0].legacyNames).to.deep.equal(["Previous Name", "Original Name"])
	})

	let tempDir: string
	let originalDlineHomeDir: string | undefined
	let originalDlineDir: string | undefined

	beforeEach(async () => {
		originalDlineHomeDir = process.env.DLINE_HOME_DIR
		originalDlineDir = process.env.DLINE_DIR
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-api-profiles-"))
		process.env.DLINE_HOME_DIR = path.join(tempDir, "home")
		process.env.DLINE_DIR = path.join(tempDir, "state")
		;(ModelRegistry as any).instance = undefined
		resetAllStores()
	})

	afterEach(async () => {
		if (originalDlineHomeDir === undefined) {
			delete process.env.DLINE_HOME_DIR
		} else {
			process.env.DLINE_HOME_DIR = originalDlineHomeDir
		}
		if (originalDlineDir === undefined) {
			delete process.env.DLINE_DIR
		} else {
			process.env.DLINE_DIR = originalDlineDir
		}
		resetAllStores()
		;(ModelRegistry as any).instance = undefined
		await fs.rm(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("hydrates migrated provider profiles with apiKey in the returned list without storing it in api_profiles.json", async () => {
		const providersDir = path.join(process.env.DLINE_HOME_DIR!, "providers")
		await fs.mkdir(providersDir, { recursive: true })
		await fs.writeFile(
			path.join(providersDir, "anthropic.json"),
			JSON.stringify({
				provider: "anthropic",
				defaultModelId: "claude-3-5-sonnet",
				models: {
					"claude-3-5-sonnet": {},
				},
			}),
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				getSecretKey: (key: string) => (key === "apiKey" ? "sk-ant-test" : undefined),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles).to.have.length(1)
		expect(response.profiles[0].provider).to.equal("anthropic")
		expect(response.profiles[0].apiKey).to.equal("sk-ant-test")
		expect(response.profiles[0].enabled).to.equal(true)
		expect(response.profiles[0].usedFor).to.deep.equal(["act", "plan", "subagents"])

		const storedProfilesPath = path.join(process.env.DLINE_DIR!, "data", "settings", "api_profiles.json")
		const storedProfiles = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(storedProfiles[0]).not.to.have.property("apiKey")
		expect(storedProfiles[0]).not.to.have.property("api_key")

		const keyEntries = Object.values(getAllApiKeys())
		expect(keyEntries).to.have.length(1)
		expect(keyEntries[0].apiKey).to.equal("sk-ant-test")
	})

	it("stores API keys for every registered provider only in secrets storage", async () => {
		const profiles = PROVIDER_OPTIONS.map(({ value: provider }, index) =>
			ApiProfile.create({
				id: `all-provider-${index}`,
				name: `E2E ${provider}`,
				provider,
				apiKey: `secret-${provider}`,
				modelId: `model-${provider}`,
				usedFor: ["act", "plan", "subagents"],
				enabled: true,
			}),
		)

		await updateApiProfiles({} as any, { profiles, clearApiKeyProfileIds: [] })

		const profilesPath = path.join(process.env.DLINE_DIR!, "data", "settings", "api_profiles.json")
		const raw = await fs.readFile(profilesPath, "utf8")
		for (const { value: provider } of PROVIDER_OPTIONS) {
			expect(raw).not.to.include(`secret-${provider}`)
		}

		const storedKeys = getAllApiKeys()
		expect(Object.keys(storedKeys)).to.have.length(PROVIDER_OPTIONS.length)
		for (const profile of profiles) {
			expect(storedKeys[profile.id]).to.deep.equal({ apiKey: profile.apiKey, name: profile.name })
		}

		const restored = readApiProfiles()
		for (const profile of profiles) {
			expect(restored.find((candidate) => candidate.id === profile.id)?.apiKey).to.equal(profile.apiKey)
		}
	})

	it("preserves empty-key snapshots unless the Profile explicitly clears or deletes the secret", async () => {
		const controller = { postStateToWebview: vi.fn() } as any
		const profileId = "profile-key-lifecycle"
		const createProfile = (name: string, apiKey = "") =>
			ApiProfile.create({
				id: profileId,
				name,
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey,
				usedFor: ["act"],
				enabled: true,
			})

		await updateApiProfiles(controller, {
			profiles: [createProfile("Original Profile", "sk-preserved")],
			clearApiKeyProfileIds: [],
		})
		expect(getAllApiKeys()[profileId]).to.deep.equal({ apiKey: "sk-preserved", name: "Original Profile" })

		await updateApiProfiles(controller, {
			profiles: [createProfile("Renamed Profile")],
			clearApiKeyProfileIds: [],
		})
		expect(getAllApiKeys()[profileId]).to.deep.equal({ apiKey: "sk-preserved", name: "Renamed Profile" })

		await updateApiProfiles(controller, {
			profiles: [createProfile("Renamed Profile")],
			clearApiKeyProfileIds: [profileId],
		})
		expect(getAllApiKeys()).not.to.have.property(profileId)

		await updateApiProfiles(controller, {
			profiles: [createProfile("Restored Profile", "sk-restored")],
			clearApiKeyProfileIds: [],
		})
		await updateApiProfiles(controller, { profiles: [], clearApiKeyProfileIds: [] })
		expect(getAllApiKeys()).not.to.have.property(profileId)
	})

	it("moves nested provider credentials to provider_secrets.json while preserving non-secret options", async () => {
		const profiles = [
			ApiProfile.create({
				id: "bedrock-secrets",
				name: "Bedrock secrets",
				provider: "bedrock",
				modelId: "bedrock-model",
				usedFor: ["act"],
				enabled: true,
				bedrock: {
					awsRegion: "us-west-2",
					awsAuthentication: "credentials",
					awsAccessKey: "bedrock-access-key",
					awsSecretKey: "bedrock-secret-key",
					awsSessionToken: "bedrock-session-token",
					awsBedrockApiKey: "bedrock-api-key",
				},
			}),
			ApiProfile.create({
				id: "sapaicore-secrets",
				name: "SAP AI Core secrets",
				provider: "sapaicore",
				modelId: "sap-model",
				usedFor: ["plan"],
				enabled: true,
				sapaicore: {
					clientId: "sap-client-id",
					clientSecret: "sap-client-secret",
					resourceGroup: "sap-resource-group",
					tokenUrl: "https://sap.example.test/token",
					useOrchestrationMode: true,
				},
			}),
		]

		await updateApiProfiles({} as any, { profiles, clearApiKeyProfileIds: [] })

		const profilesPath = path.join(process.env.DLINE_DIR!, "data", "settings", "api_profiles.json")
		const raw = await fs.readFile(profilesPath, "utf8")
		expect(raw).not.to.include("bedrock-access-key")
		expect(raw).not.to.include("bedrock-secret-key")
		expect(raw).not.to.include("bedrock-session-token")
		expect(raw).not.to.include("bedrock-api-key")
		expect(raw).not.to.include("sap-client-secret")
		expect(raw).to.include("us-west-2")
		expect(raw).to.include("sap-client-id")
		expect(raw).to.include("sap-resource-group")

		const providerSecretsPath = path.join(process.env.DLINE_DIR!, "data", "secrets", "provider_secrets.json")
		const providerSecrets = JSON.parse(await fs.readFile(providerSecretsPath, "utf8"))
		expect(providerSecrets["bedrock-secrets"].secrets).to.deep.equal({
			awsAccessKey: "bedrock-access-key",
			awsSecretKey: "bedrock-secret-key",
			awsSessionToken: "bedrock-session-token",
			awsBedrockApiKey: "bedrock-api-key",
		})
		expect(providerSecrets["sapaicore-secrets"].secrets).to.deep.equal({ clientSecret: "sap-client-secret" })

		resetAllStores()
		const restored = readApiProfiles()
		const bedrock = restored.find((profile) => profile.id === "bedrock-secrets")
		const sapaicore = restored.find((profile) => profile.id === "sapaicore-secrets")
		expect(bedrock?.bedrock?.awsAccessKey).to.equal("bedrock-access-key")
		expect(bedrock?.bedrock?.awsSecretKey).to.equal("bedrock-secret-key")
		expect(bedrock?.bedrock?.awsSessionToken).to.equal("bedrock-session-token")
		expect(bedrock?.bedrock?.awsBedrockApiKey).to.equal("bedrock-api-key")
		expect(sapaicore?.sapaicore?.clientSecret).to.equal("sap-client-secret")
	})

	it("migrates embedded provider credentials from an existing api_profiles.json", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const profilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			profilesPath,
			JSON.stringify([
				{
					id: "legacy-bedrock",
					name: "Legacy Bedrock",
					provider: "bedrock",
					modelId: "legacy-bedrock-model",
					usedFor: ["act"],
					enabled: true,
					bedrock: {
						awsRegion: "us-east-1",
						awsAccessKey: "legacy-access-key",
						awsSecretKey: "legacy-secret-key",
					},
				},
				{
					id: "legacy-sap",
					name: "Legacy SAP",
					provider: "sapaicore",
					modelId: "legacy-sap-model",
					usedFor: ["plan"],
					enabled: true,
					sapaicore: { clientId: "legacy-client-id", clientSecret: "legacy-client-secret" },
				},
			]),
			"utf8",
		)
		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles.find((profile) => profile.id === "legacy-bedrock")?.bedrock?.awsAccessKey).to.equal(
			"legacy-access-key",
		)
		expect(response.profiles.find((profile) => profile.id === "legacy-sap")?.sapaicore?.clientSecret).to.equal(
			"legacy-client-secret",
		)
		const rewritten = await fs.readFile(profilesPath, "utf8")
		expect(rewritten).not.to.include("legacy-access-key")
		expect(rewritten).not.to.include("legacy-secret-key")
		expect(rewritten).not.to.include("legacy-client-secret")
		const providerSecrets = JSON.parse(
			await fs.readFile(path.join(process.env.DLINE_DIR!, "data", "secrets", "provider_secrets.json"), "utf8"),
		)
		expect(providerSecrets["legacy-bedrock"].secrets).to.deep.equal({
			awsAccessKey: "legacy-access-key",
			awsSecretKey: "legacy-secret-key",
		})
		expect(providerSecrets["legacy-sap"].secrets).to.deep.equal({ clientSecret: "legacy-client-secret" })
	})

	it("hydrates official modelInfo from providers json and strips stored profile snapshots", async () => {
		const providersDir = path.join(process.env.DLINE_HOME_DIR!, "providers")
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(providersDir, { recursive: true })
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(providersDir, "deepseek.json"),
			JSON.stringify({
				provider: "deepseek",
				providerName: "DeepSeek",
				billingMode: "token",
				defaultModelId: "deepseek-v4-pro",
				models: {
					"deepseek-v4-pro": {
						id: "deepseek-v4-pro",
						capabilities: {
							contextWindow: 272_000,
							maxTokens: 128_000,
							supportsImages: false,
							supportsPromptCache: true,
						},
						pricing: {
							inputPrice: 1,
							outputPrice: 2,
						},
					},
				},
			}),
			"utf8",
		)
		await fs.writeFile(
			storedProfilesPath,
			JSON.stringify(
				[
					{
						id: "deepseek-profile",
						name: "deepseek:deepseek-v4-pro",
						provider: "deepseek",
						modelId: "deepseek-v4-pro",
						usedFor: ["act", "plan"],
						enabled: true,
						modelInfo: {
							id: "deepseek-v4-pro",
							capabilities: {
								contextWindow: 1_000_000,
								maxTokens: 64_000,
							},
						},
					},
				],
				null,
				"\t",
			),
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles).to.have.length(1)
		// Runtime consumers receive current registry capabilities, while the
		// persisted Profile still omits the derived snapshot.
		expect(response.profiles[0].modelInfo?.capabilities?.contextWindow).to.equal(272_000)
		expect(response.profiles[0].modelInfo?.capabilities?.maxTokens).to.equal(128_000)
		expect(response.profiles[0].modelInfo?.capabilities?.supportsPromptCache).to.equal(true)

		const storedProfiles = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(storedProfiles[0]).not.to.have.property("modelInfo")
	})

	it("stores only editable modelInfo overrides without rewriting normalized reads", async () => {
		const providersDir = path.join(process.env.DLINE_HOME_DIR!, "providers")
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(providersDir, { recursive: true })
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(providersDir, "openai.json"),
			JSON.stringify({
				provider: "openai",
				providerName: "OpenAI Compatible",
				billingMode: "token",
				defaultModelId: "gpt-compatible",
				models: {
					"gpt-compatible": {
						id: "gpt-compatible",
						capabilities: {
							contextWindow: 128_000,
							maxTokens: 8_192,
							supportsImages: false,
							supportsPromptCache: true,
						},
						pricing: {
							inputPrice: 1,
							outputPrice: 2,
							currency: "USD",
						},
					},
				},
			}),
			"utf8",
		)
		await fs.writeFile(
			storedProfilesPath,
			JSON.stringify(
				[
					{
						id: "openai-profile",
						name: "openai:gpt-compatible",
						provider: "openai",
						modelId: "gpt-compatible",
						usedFor: ["act", "plan"],
						enabled: true,
						modelInfo: {
							id: "gpt-compatible",
							capabilities: {
								contextWindow: 256_000,
							},
							pricing: {
								inputPrice: 1,
								outputPrice: 3,
							},
						},
					},
				],
				null,
				"\t",
			),
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles[0].modelInfo?.capabilities?.contextWindow).to.equal(256_000)
		expect(response.profiles[0].modelInfo?.capabilities?.maxTokens).to.equal(8_192)
		expect(response.profiles[0].modelInfo?.capabilities?.supportsPromptCache).to.equal(true)
		expect(response.profiles[0].modelInfo?.pricing?.inputPrice).to.equal(1)
		expect(response.profiles[0].modelInfo?.pricing?.outputPrice).to.equal(3)

		const storedProfiles = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(storedProfiles[0].modelInfo).to.deep.equal({
			id: "gpt-compatible",
			capabilities: {
				contextWindow: 256_000,
			},
			pricing: {
				outputPrice: 3,
			},
		})

		const logSpy = vi.spyOn(Logger, "log")
		readApiProfiles()
		await new Promise((resolve) => setTimeout(resolve, 100))
		readApiProfiles()
		await new Promise((resolve) => setTimeout(resolve, 100))
		const cleanRewriteLogs = logSpy.mock.calls.filter(([message]) =>
			String(message).includes("[cleanRewriteApiProfiles] Stripped apiKey fields from api_profiles.json"),
		)
		expect(cleanRewriteLogs).to.have.length(0)
	})

	it("keeps modelInfo for user-configurable OpenAI compatible profiles", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			storedProfilesPath,
			JSON.stringify(
				[
					{
						id: "openai-compatible-profile",
						name: "openai:custom-model",
						provider: "openai",
						modelId: "custom-model",
						usedFor: ["act", "plan"],
						enabled: true,
						modelInfo: {
							id: "custom-model",
							capabilities: {
								contextWindow: 64_000,
								maxTokens: 8_192,
							},
						},
					},
				],
				null,
				"\t",
			),
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles[0].modelInfo?.capabilities?.contextWindow).to.equal(64_000)
		const storedProfiles = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(storedProfiles[0]).to.have.property("modelInfo")
	})

	it("keeps modelInfo for custom Anthropic profiles", async () => {
		const providersDir = path.join(process.env.DLINE_HOME_DIR!, "providers")
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(providersDir, { recursive: true })
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(providersDir, "anthropic.json"),
			JSON.stringify({
				provider: "anthropic",
				providerName: "Anthropic",
				billingMode: "token",
				defaultModelId: "claude-sonnet-4-6",
				models: {
					"claude-sonnet-4-6": {
						id: "claude-sonnet-4-6",
						capabilities: {
							contextWindow: 200_000,
							maxTokens: 64_000,
						},
					},
				},
			}),
			"utf8",
		)
		await fs.writeFile(
			storedProfilesPath,
			JSON.stringify(
				[
					{
						id: "anthropic-custom-profile",
						name: "anthropic:internal-claude",
						provider: "anthropic",
						modelId: "internal-claude",
						usedFor: ["act", "plan"],
						enabled: true,
						modelInfo: {
							id: "internal-claude",
							capabilities: {
								contextWindow: 96_000,
								maxTokens: 16_384,
							},
						},
					},
				],
				null,
				"\t",
			),
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles[0].modelInfo?.capabilities?.contextWindow).to.equal(96_000)
		const storedProfiles = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(storedProfiles[0]).to.have.property("modelInfo")
	})

	it("keeps api_profiles.json valid when delete/update writes are issued back to back", async () => {
		const largeProfiles = Array.from({ length: 40 }, (_, index) => ({
			id: `profile-${index}`,
			name: `deepseek:model-${index}`,
			provider: "deepseek",
			modelId: `model-${index}`,
			usedFor: ["act", "plan"],
			enabled: true,
			modelInfo: {
				id: `model-${index}`,
				name: `model-${index}`,
				description: "x".repeat(2000),
				pricing: {
					inputPrice: index,
					outputPrice: index + 1,
				},
			},
		}))
		const finalProfiles = [
			{
				id: "final-profile",
				name: "openai:gpt-5.5",
				provider: "openai",
				modelId: "gpt-5.5",
				usedFor: ["act", "plan"],
				enabled: true,
			},
		]

		const controller = {} as any
		const firstWrite = updateApiProfiles(controller, { profiles: largeProfiles } as any)
		const deleteWrite = updateApiProfiles(controller, { profiles: finalProfiles } as any)

		await Promise.all([firstWrite, deleteWrite])

		const storedProfilesPath = path.join(process.env.DLINE_DIR!, "data", "settings", "api_profiles.json")
		const raw = await fs.readFile(storedProfilesPath, "utf8")
		const storedProfiles = JSON.parse(raw)

		expect(storedProfiles).to.have.length(1)
		expect(storedProfiles[0].id).to.equal("final-profile")
		expect(raw).not.to.include("profile-39")
	})

	it("persists the provider registry default when a profile modelId is blank", async () => {
		const providersDir = path.join(process.env.DLINE_HOME_DIR!, "providers")
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(providersDir, { recursive: true })
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(providersDir, "openai.json"),
			JSON.stringify({
				provider: "openai",
				defaultModelId: "registry-default-model",
				models: { "registry-default-model": { id: "registry-default-model" } },
			}),
			"utf8",
		)
		await fs.writeFile(
			storedProfilesPath,
			JSON.stringify([
				{
					id: "default-profile",
					name: "openai profile",
					provider: "openai",
					modelId: "",
					usedFor: ["act", "plan"],
					enabled: true,
				},
			]),
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles[0].modelId).to.equal("registry-default-model")
		const storedProfiles = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(storedProfiles[0].modelId).to.equal("registry-default-model")
	})

	it("removes legacy Image uses while preserving only explicitly bound legacy Current profiles", async () => {
		const providersDir = path.join(process.env.DLINE_HOME_DIR!, "providers")
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(providersDir, { recursive: true })
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(providersDir, "openai.json"),
			JSON.stringify({
				provider: "openai",
				providerName: "OpenAI",
				billingMode: "token",
				defaultModelId: "gpt-chat",
				models: { "gpt-chat": { id: "gpt-chat" } },
				defaultImageModelId: "gpt-image-2",
				imageModels: { "gpt-image-2": { id: "gpt-image-2" } },
			}),
			"utf8",
		)
		await fs.writeFile(
			storedProfilesPath,
			JSON.stringify([
				{
					id: "explicit-image-profile",
					name: "OpenAI explicit image",
					provider: "openai",
					modelId: "gpt-chat",
					imageModelId: "custom-image-model",
					usedFor: ["act", "image"],
					enabled: true,
				},
				{
					id: "default-image-profile",
					name: "OpenAI default image",
					provider: "openai",
					modelId: "gpt-chat",
					imageModelId: "",
					usedFor: ["plan", "image"],
					enabled: true,
				},
				{
					id: "legacy-profile",
					name: "OpenAI legacy",
					provider: "openai",
					modelId: "gpt-chat",
					usedFor: ["act", "plan", "subagents"],
					enabled: true,
				},
			]),
			"utf8",
		)
		const setGlobalState = vi.fn()
		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState,
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))
		const profiles = response.profiles as unknown as Array<{
			id: string
			modelId: string
			imageSource?: ImageGenerationSource
			imageModelId?: string
			usedFor: string[]
		}>

		expect(profiles.find((profile) => profile.id === "explicit-image-profile")?.imageSource).to.equal(
			ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
		)
		expect(profiles.find((profile) => profile.id === "explicit-image-profile")?.imageModelId).to.equal("custom-image-model")
		expect(profiles.find((profile) => profile.id === "default-image-profile")?.imageSource).to.equal(
			ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED,
		)
		expect(profiles.find((profile) => profile.id === "default-image-profile")?.imageModelId).to.equal(undefined)
		expect(profiles.find((profile) => profile.id === "default-image-profile")?.modelId).to.equal("gpt-chat")
		expect(profiles.find((profile) => profile.id === "explicit-image-profile")?.usedFor).to.deep.equal(["act"])
		expect(profiles.find((profile) => profile.id === "default-image-profile")?.usedFor).to.deep.equal(["plan"])
		expect(profiles.find((profile) => profile.id === "legacy-profile")?.imageSource).to.equal(
			ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED,
		)
		expect(profiles.find((profile) => profile.id === "legacy-profile")?.imageModelId).to.equal(undefined)
		expect(profiles.find((profile) => profile.id === "legacy-profile")?.usedFor).to.deep.equal(["act", "plan", "subagents"])
		expect(setGlobalState.mock.calls.some(([key]) => key === "imageProfileId" || key === "imageProfile")).to.equal(false)

		const stored = JSON.parse(await fs.readFile(storedProfilesPath, "utf8"))
		expect(stored.find((profile: { id: string }) => profile.id === "explicit-image-profile").imageModelId).to.equal(
			"custom-image-model",
		)
		expect(stored.find((profile: { id: string }) => profile.id === "default-image-profile").imageModelId).to.equal(undefined)
		expect(stored.find((profile: { id: string }) => profile.id === "legacy-profile").imageModelId).to.equal(undefined)
	})

	it("rejects an unreadable profile file instead of returning an empty list", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(path.join(settingsDir, "api_profiles.json"), "not-json", "utf8")
		const controller = {} as any

		let thrown: unknown
		try {
			await getApiProfiles(controller, EmptyRequest.create({}))
		} catch (error) {
			thrown = error
		}
		expect(thrown).to.be.instanceOf(SyntaxError)
	})

	it("recovers api_profiles.json when a valid array has trailing broken JSON", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(settingsDir, { recursive: true })
		const validPrefix = [
			{
				id: "deepseek-profile",
				name: "deepseek:deepseek-v4-pro",
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
				usedFor: ["act", "plan"],
				enabled: true,
			},
		]
		await fs.writeFile(
			storedProfilesPath,
			`${JSON.stringify(validPrefix, null, "\t")},\n\t\t\t\t"outputPrice": 0\n\t\t\t}\n\t\t}\n\t}\n]`,
			"utf8",
		)

		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState: vi.fn(),
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn(),
		} as any

		const response = await getApiProfiles(controller, EmptyRequest.create({}))

		expect(response.profiles).to.have.length(1)
		expect(response.profiles[0].id).to.equal("deepseek-profile")

		const repairedRaw = await fs.readFile(storedProfilesPath, "utf8")
		const repairedProfiles = JSON.parse(repairedRaw)
		expect(repairedProfiles).to.have.length(1)
		expect(repairedProfiles[0].id).to.equal("deepseek-profile")
		expect(repairedRaw.trim().endsWith("]")).to.equal(true)
		expect(repairedRaw).not.to.include('"outputPrice": 0')
	})

	it("initializes absent global bindings with stable ID and display name", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(settingsDir, "api_profiles.json"),
			JSON.stringify([
				{
					id: "initial-profile",
					name: "Initial Profile",
					provider: "openai",
					modelId: "gpt-initial",
					usedFor: ["plan", "act"],
					enabled: true,
				},
			]),
			"utf8",
		)
		const setGlobalState = vi.fn()
		const flushPendingState = vi.fn().mockResolvedValue(undefined)
		const controller = {
			stateManager: {
				getApiConfiguration: () => ({}),
				setGlobalState,
				flushPendingState,
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as any

		await getApiProfiles(controller, EmptyRequest.create({}))

		expect(setGlobalState.mock.calls).to.deep.include(["planModeProfileId", "initial-profile"])
		expect(setGlobalState.mock.calls).to.deep.include(["planModeProfile", "Initial Profile"])
		expect(setGlobalState.mock.calls).to.deep.include(["actModeProfileId", "initial-profile"])
		expect(setGlobalState.mock.calls).to.deep.include(["actModeProfile", "Initial Profile"])
		expect(flushPendingState.mock.calls.length).to.equal(2)
	})

	it("does not replace an explicitly missing stable Profile ID with a fallback", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		await fs.mkdir(settingsDir, { recursive: true })
		await fs.writeFile(
			path.join(settingsDir, "api_profiles.json"),
			JSON.stringify([
				{
					id: "fallback-id",
					name: "Fallback Profile",
					provider: "openai",
					modelId: "gpt-fallback",
					usedFor: ["plan", "act"],
					enabled: true,
				},
			]),
			"utf8",
		)
		const setGlobalState = vi.fn()
		const controller = {
			stateManager: {
				getApiConfiguration: () => ({
					planModeProfileId: "missing-id",
					planModeProfile: "Deleted Profile",
					actModeProfileId: "missing-id",
					actModeProfile: "Deleted Profile",
				}),
				setGlobalState,
				flushPendingState: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as any

		await getApiProfiles(controller, EmptyRequest.create({}))

		expect(setGlobalState.mock.calls).to.have.length(0)
	})

	it("caches synchronous profile reads until the profile file changes", async () => {
		const settingsDir = path.join(process.env.DLINE_DIR!, "data", "settings")
		const storedProfilesPath = path.join(settingsDir, "api_profiles.json")
		await fs.mkdir(settingsDir, { recursive: true })
		const firstProfiles = [
			ApiProfile.create({
				id: "profile-1",
				name: "deepseek profile",
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
				enabled: true,
			}),
		]
		await writeApiProfilesToFile(storedProfilesPath, firstProfiles)
		const readFileSpy = vi.spyOn(fsSync, "readFileSync")

		expect(readApiProfiles()[0].id).to.equal("profile-1")
		expect(readApiProfiles()[0].id).to.equal("profile-1")
		expect(readFileSpy.mock.calls).to.have.length(1)

		await writeApiProfilesToFile(storedProfilesPath, [
			ApiProfile.create({ ...firstProfiles[0], id: "profile-2", name: "updated profile" }),
		])
		expect(readApiProfiles()[0].id).to.equal("profile-2")
		expect(readFileSpy.mock.calls).to.have.length(2)
	})
})
