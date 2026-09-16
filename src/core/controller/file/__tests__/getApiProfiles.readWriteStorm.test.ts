import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EmptyRequest } from "@shared/proto/dline/common"
import { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * P0 regression guard: a Catalog read must not keep rewriting the Catalog file.
 *
 * `getApiProfiles` is served by every Controller (sidebar plus each editor panel).
 * When a read wrote the file, the write woke the Catalog watcher, the watcher
 * advanced the Catalog revision, every Webview reloaded, and each reload wrote
 * again. With several panels open, `api_profiles.json` never reached the
 * watcher's stability window and newly opened panels stayed on
 * "Loading profiles…" no matter how small the file was.
 */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-profile-storm-"))

vi.mock("@core/storage/disk", () => ({
	getDlineDataDir: () => dataDir,
}))

function createController() {
	return {
		stateManager: {
			flushPendingState: vi.fn().mockResolvedValue(undefined),
			getApiConfiguration: vi.fn().mockReturnValue({}),
			setGlobalState: vi.fn(),
			setGlobalStateBatch: vi.fn(),
			getGlobalSettingsKey: vi.fn(),
		},
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
	} as never
}

async function writeCatalog(profiles: unknown[]): Promise<string> {
	const settingsDir = path.join(dataDir, "settings")
	await fs.mkdir(settingsDir, { recursive: true })
	const filePath = path.join(settingsDir, "api_profiles.json")
	await fs.writeFile(filePath, JSON.stringify(profiles, null, "\t"), "utf8")
	return filePath
}

describe("getApiProfiles read/write storm", () => {
	beforeEach(async () => {
		vi.resetModules()
	})

	afterEach(async () => {
		await fs.rm(path.join(dataDir, "settings"), { recursive: true, force: true })
	})

	it("does not rewrite the Catalog on every read once registry drift is repaired", async () => {
		const filePath = await writeCatalog([
			{ id: "profile-1", name: "openai:gpt-4o", provider: "openai", modelId: "gpt-4o", enabled: true },
		])
		const module = await import("../getApiProfiles")
		module.resetRegistryModelInfoRepairGateForTest()

		const controller = createController()
		await module.getApiProfiles(controller, EmptyRequest.create({}))
		// Let any fire-and-forget repair settle before sampling the file identity.
		await new Promise((resolve) => setTimeout(resolve, 50))
		const afterFirst = await fs.stat(filePath)

		for (let index = 0; index < 5; index++) {
			await module.getApiProfiles(controller, EmptyRequest.create({}))
		}
		await new Promise((resolve) => setTimeout(resolve, 50))
		const afterRepeats = await fs.stat(filePath)

		// Repeated reads must leave the Catalog byte-identical, so the watcher stays quiet.
		expect(afterRepeats.mtimeMs).toBe(afterFirst.mtimeMs)
		expect(afterRepeats.size).toBe(afterFirst.size)
	})

	it("rewrites a legacy disk Catalog once and then settles", async () => {
		const filePath = await writeCatalog([
			{
				id: "legacy-profile",
				name: "custom-provider:legacy-model",
				provider: "custom-provider",
				modelId: "legacy-model",
			},
		])
		const module = await import("../getApiProfiles")
		const { Logger } = await import("@shared/services/Logger")
		module.resetRegistryModelInfoRepairGateForTest()
		const logSpy = vi.spyOn(Logger, "log")
		const controller = createController()

		const first = await module.getApiProfiles(controller, EmptyRequest.create({}))
		const afterMigration = await fs.stat(filePath)
		const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Array<Record<string, unknown>>
		await module.getApiProfiles(controller, EmptyRequest.create({}))
		const afterRepeat = await fs.stat(filePath)

		const cleanRewriteLogs = logSpy.mock.calls.filter(([message]) =>
			String(message).includes("[cleanRewriteApiProfiles] Stripped apiKey fields from api_profiles.json"),
		)
		expect(first.profiles[0].enabled).toBe(true)
		expect(stored[0].enabled).toBe(true)
		expect(cleanRewriteLogs).toHaveLength(1)
		expect(afterRepeat.mtimeMs).toBe(afterMigration.mtimeMs)
		expect(afterRepeat.size).toBe(afterMigration.size)
	})

	it("does not let request normalization rewrite an already-clean Catalog", async () => {
		// A registry-known model keeps registry drift out of this scenario, so the
		// only rewrite trigger left to observe is request normalization.
		const filePath = await writeCatalog([
			{ id: "stable-profile", name: "openai:gpt-4o", provider: "openai", modelId: "gpt-4o", enabled: true },
		])
		const module = await import("../getApiProfiles")
		const { Logger } = await import("@shared/services/Logger")
		module.resetRegistryModelInfoRepairGateForTest()
		const controller = createController()
		// Settle the one-time registry repair before sampling the file identity.
		await module.getApiProfiles(controller, EmptyRequest.create({}))
		await new Promise((resolve) => setTimeout(resolve, 50))
		const logSpy = vi.spyOn(Logger, "log")
		const before = await fs.stat(filePath)

		for (let index = 0; index < 3; index++) {
			// updateApiProfiles also calls this public normalizer. A legacy request
			// must not schedule a clean rewrite for an unrelated disk Catalog.
			module.normalizeApiProfile({
				id: `legacy-request-${index}`,
				name: `legacy-request-${index}`,
				provider: "custom-provider",
				modelId: "legacy-model",
			})
			await module.getApiProfiles(controller, EmptyRequest.create({}))
		}
		await new Promise((resolve) => setTimeout(resolve, 50))

		const after = await fs.stat(filePath)
		const cleanRewriteLogs = logSpy.mock.calls.filter(([message]) =>
			String(message).includes("[cleanRewriteApiProfiles] Stripped apiKey fields from api_profiles.json"),
		)
		expect(cleanRewriteLogs).toHaveLength(0)
		expect(after.mtimeMs).toBe(before.mtimeMs)
		expect(after.size).toBe(before.size)
	})

	it("does not overwrite a Catalog that changed after the migration snapshot was read", async () => {
		const staleProfiles = [{ id: "legacy", name: "Legacy", provider: "custom-provider", modelId: "legacy-model" }]
		const filePath = await writeCatalog(staleProfiles)
		const staleRaw = await fs.readFile(filePath, "utf8")
		const module = await import("../getApiProfiles")
		const externalProfiles = [
			{ id: "external", name: "External", provider: "openai", modelId: "gpt-4o", enabled: true, schemaVersion: 2 },
		]
		const externalRaw = JSON.stringify(externalProfiles, null, "\t")
		await fs.writeFile(filePath, externalRaw, "utf8")

		const rewritten = await module.cleanRewriteApiProfiles(
			staleRaw,
			staleProfiles.map((profile) => ApiProfile.fromJSON({ ...profile, enabled: true, schemaVersion: 2 })),
		)

		expect(rewritten).toBe(false)
		expect(await fs.readFile(filePath, "utf8")).toBe(externalRaw)
	})

	it("keeps repeated synchronous reads from rewriting the Catalog", async () => {
		const filePath = await writeCatalog([
			{ id: "profile-1", name: "openai:gpt-4o", provider: "openai", modelId: "gpt-4o", enabled: true },
		])
		const module = await import("../getApiProfiles")
		module.resetRegistryModelInfoRepairGateForTest()

		module.readApiProfiles()
		await new Promise((resolve) => setTimeout(resolve, 50))
		const afterFirst = await fs.stat(filePath)

		for (let index = 0; index < 10; index++) {
			module.readApiProfiles()
		}
		await new Promise((resolve) => setTimeout(resolve, 50))
		const afterRepeats = await fs.stat(filePath)

		expect(afterRepeats.mtimeMs).toBe(afterFirst.mtimeMs)
		expect(afterRepeats.size).toBe(afterFirst.size)
	})
})
