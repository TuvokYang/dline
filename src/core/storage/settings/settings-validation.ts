import {
    MAX_AUTO_CONDENSE_CONTEXT_TOKENS,
    MAX_AUTO_CONDENSE_TRIGGER_PERCENT,
    MIN_AUTO_CONDENSE_TRIGGER_PERCENT,
} from "@shared/auto-condense"
import type { Settings } from "@shared/storage/state-keys"
import {
    type PersistedSettingsDocument,
    SETTINGS_REPOSITORY_REVISION_KEY,
    SETTINGS_REPOSITORY_SCHEMA_KEY,
    SETTINGS_REPOSITORY_SOURCE_ID_KEY,
} from "./settings-types"

const METADATA_KEYS = new Set<string>([
    SETTINGS_REPOSITORY_REVISION_KEY,
    SETTINGS_REPOSITORY_SCHEMA_KEY,
    SETTINGS_REPOSITORY_SOURCE_ID_KEY,
])

export interface ParsedSettingsDocument {
    readonly document: Record<string, unknown>
    readonly revision: number
    readonly sourceId: string
    readonly values: Settings
}

export function parseSettingsDocument(input: unknown): ParsedSettingsDocument {
    const document = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {}
    const revisionValue = document[SETTINGS_REPOSITORY_REVISION_KEY]
    const sourceIdValue = document[SETTINGS_REPOSITORY_SOURCE_ID_KEY]
    const values: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(document)) {
        if (!METADATA_KEYS.has(key)) values[key] = value
    }
    return {
        document,
        revision: Number.isSafeInteger(revisionValue) && Number(revisionValue) >= 0 ? Number(revisionValue) : 0,
        sourceId: typeof sourceIdValue === "string" ? sourceIdValue : "legacy",
        values: values as Settings,
    }
}

export function applySettingsPatch(current: Settings, patch: Partial<Settings>): Settings {
    const next = { ...(current as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch)) {
        if (METADATA_KEYS.has(key)) throw new Error(`Reserved Settings repository key cannot be mutated: ${key}`)
        if (value === undefined) delete next[key]
        else next[key] = value
    }
    validateSettings(next as Settings)
    return next as Settings
}

export function buildPersistedSettingsDocument(values: Settings, revision: number, sourceId: string): PersistedSettingsDocument {
    return {
        ...(values as Record<string, unknown>),
        [SETTINGS_REPOSITORY_SCHEMA_KEY]: 1,
        [SETTINGS_REPOSITORY_REVISION_KEY]: revision,
        [SETTINGS_REPOSITORY_SOURCE_ID_KEY]: sourceId,
    }
}

export function validateSettings(values: Settings): void {
    const trigger = values.autoCondenseTriggerPercent
    if (
        trigger !== undefined &&
        (!Number.isSafeInteger(trigger) ||
            trigger < MIN_AUTO_CONDENSE_TRIGGER_PERCENT ||
            trigger > MAX_AUTO_CONDENSE_TRIGGER_PERCENT)
    ) {
        throw new Error(
            `Auto-compact trigger must be an integer from ${MIN_AUTO_CONDENSE_TRIGGER_PERCENT} to ${MAX_AUTO_CONDENSE_TRIGGER_PERCENT} percent`,
        )
    }

    const maxContext = values.autoCondenseMaxContextTokens
    if (
        maxContext !== undefined &&
        (!Number.isSafeInteger(maxContext) || maxContext < 0 || maxContext > MAX_AUTO_CONDENSE_CONTEXT_TOKENS)
    ) {
        throw new Error(`Auto-compact maximum context must be an integer from 0 to ${MAX_AUTO_CONDENSE_CONTEXT_TOKENS} tokens`)
    }
}
