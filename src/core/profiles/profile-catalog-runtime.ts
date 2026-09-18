import path from "node:path"
import {
	invalidateApiProfilesReadCache,
	readApiProfilesFresh,
	writeApiProfilesToFile,
} from "@core/controller/file/getApiProfiles"
import { reconcileOpenAiCodexProfileAuth } from "@core/controller/file/openAiCodexProfileAuthLifecycle"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import { getDlineDataDir } from "@core/storage/disk"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { Logger } from "@shared/services/Logger"
import { ProfileCatalogRepository } from "./ProfileCatalogRepository"
import { advanceProfileCatalogRevision } from "./profile-catalog-state"

const API_PROFILES_FILE = "api_profiles.json"
const repositories = new Map<string, Promise<ProfileCatalogRepository>>()

export interface ExternalProfileCatalogCommitDependencies {
	invalidateReadCache(): void
	advanceRevision(): void
	reconcile(previous: readonly ApiProfile[], profiles: readonly ApiProfile[]): Promise<void>
	publish(previous: ApiProfile[], profiles: ApiProfile[]): Promise<void>
}

export async function handleExternalProfileCatalogCommit(
	previous: ApiProfile[],
	profiles: ApiProfile[],
	dependencies: ExternalProfileCatalogCommitDependencies = {
		invalidateReadCache: invalidateApiProfilesReadCache,
		advanceRevision: advanceProfileCatalogRevision,
		reconcile: reconcileOpenAiCodexProfileAuth,
		publish: (before, after) => OrchestratorController.getInstance().profileChanges.publish(before, after),
	},
): Promise<void> {
	dependencies.invalidateReadCache()
	dependencies.advanceRevision()
	try {
		await dependencies.reconcile(previous, profiles)
	} catch (error) {
		Logger.error("[ProfileCatalog] External OpenAI Codex OAuth cleanup failed", error)
	}
	try {
		await dependencies.publish(previous, profiles)
	} catch (error) {
		Logger.warn("[ProfileCatalog] External commit broadcast unavailable", error)
	}
}

/** Lazily initialize one process-local repository per resolved Catalog path. */
export function getProfileCatalogRepository(): Promise<ProfileCatalogRepository> {
	const filePath = path.join(getDlineDataDir(), "settings", API_PROFILES_FILE)
	const existing = repositories.get(filePath)
	if (existing) return existing

	const initialization = (async () => {
		const created = new ProfileCatalogRepository({
			filePath,
			read: readApiProfilesFresh,
			write: (profiles) => writeApiProfilesToFile(filePath, profiles),
		})
		created.subscribe(({ previous, profiles }) => handleExternalProfileCatalogCommit(previous, profiles))
		await created.initialize()
		return created
	})()
	repositories.set(filePath, initialization)
	void initialization.catch(() => repositories.delete(filePath))
	return initialization
}
