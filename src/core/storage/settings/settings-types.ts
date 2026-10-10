import type { Settings, SettingsKey } from "@shared/storage/state-keys"

export const SETTINGS_REPOSITORY_SCHEMA_VERSION = 1 as const
export const SETTINGS_REPOSITORY_REVISION_KEY = "__settingsRepositoryRevision" as const
export const SETTINGS_REPOSITORY_SOURCE_ID_KEY = "__settingsRepositorySourceId" as const
export const SETTINGS_REPOSITORY_SCHEMA_KEY = "__settingsRepositorySchemaVersion" as const

/**
 * Marks a Settings document as already migrated out of legacy global state.
 *
 * A document carrying at least the current version is authoritative: a key it
 * omits resolves to its declared default rather than to a stale legacy value.
 * Fixtures that seed a canonical document must write the current version, or
 * startup replays the one-time migration and revives those legacy values.
 */
export const SETTINGS_MIGRATION_VERSION_KEY = "__settingsMigrationVersion" as const
export const SETTINGS_MIGRATION_VERSION = 2

export type SettingsRepositoryMetadataKey =
    | typeof SETTINGS_REPOSITORY_REVISION_KEY
    | typeof SETTINGS_REPOSITORY_SOURCE_ID_KEY
    | typeof SETTINGS_REPOSITORY_SCHEMA_KEY

export interface SettingsSnapshot {
    readonly schemaVersion: typeof SETTINGS_REPOSITORY_SCHEMA_VERSION
    readonly revision: number
    readonly values: Readonly<Settings>
    readonly contentHash: string
}

export interface SettingsCommit {
    readonly revision: number
    readonly changedKeys: readonly SettingsKey[]
    readonly snapshot: SettingsSnapshot
    readonly sourceId: string
}

export type SettingsCommitListener = (commit: SettingsCommit) => void | Promise<void>

export interface SettingsRepositoryOptions {
    readonly filePath: string
    readonly sourceId?: string
    readonly watch?: boolean
}

export interface PersistedSettingsDocument {
    readonly [key: string]: unknown
    readonly [SETTINGS_REPOSITORY_REVISION_KEY]?: number
    readonly [SETTINGS_REPOSITORY_SOURCE_ID_KEY]?: string
    readonly [SETTINGS_REPOSITORY_SCHEMA_KEY]?: number
}
