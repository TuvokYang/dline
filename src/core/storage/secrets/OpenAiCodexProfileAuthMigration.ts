import fs from "node:fs/promises"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import { FileLock } from "../backend/jsonl/FileLock"
import { getLegacyOpenAiCodexAuthMigrationPath, getLegacyOpenAiCodexAuthPath } from "./OpenAiCodexProfileAuthPath"
import { OpenAiCodexProfileAuthRepository, parseOpenAiOAuthCredentials } from "./OpenAiCodexProfileAuthRepository"

export interface OAuthProfileIdentity {
    id: string
    provider: string
}

export type OpenAiCodexProfileAuthMigrationResult =
    | { status: "missing-legacy" }
    | { status: "malformed-legacy" }
    | { status: "malformed-marker" }
    | { status: "unassigned-legacy" }
    | { status: "legacy-shared"; profileIds: string[] }
    | { status: "legacy-retired" }
    | { status: "destination-malformed"; profileId: string }
    | { status: "migrated"; profileId: string }
    | { status: "already-isolated"; profileId: string }

export interface OpenAiCodexProfileAuthMigrationOptions {
    secretsDir: string
    repository?: OpenAiCodexProfileAuthRepository
}

interface ValidLegacyCredential {
    raw: unknown
}

interface LegacySharedMarker {
    schemaVersion: 1
    mode: "legacy-shared"
    profileIds: string[]
}

type LegacySharedMarkerReadResult =
    | { status: "missing" }
    | { status: "malformed" }
    | { status: "valid"; marker: LegacySharedMarker }

async function readLegacyCredential(filePath: string): Promise<"missing" | "malformed" | ValidLegacyCredential> {
    try {
        const raw: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
        parseOpenAiOAuthCredentials(raw)
        return { raw }
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "malformed"
    }
}

async function readLegacySharedMarker(filePath: string): Promise<LegacySharedMarkerReadResult> {
    let value: unknown
    try {
        value = JSON.parse(await fs.readFile(filePath, "utf8"))
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "malformed" }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "malformed" }
    const record = value as Partial<LegacySharedMarker>
    const allowedKeys = new Set(["schemaVersion", "mode", "profileIds"])
    if (
        Object.keys(record).some((key) => !allowedKeys.has(key)) ||
        record.schemaVersion !== 1 ||
        record.mode !== "legacy-shared" ||
        !Array.isArray(record.profileIds) ||
        record.profileIds.length === 0 ||
        record.profileIds.some((profileId) => typeof profileId !== "string" || profileId.length === 0)
    ) {
        return { status: "malformed" }
    }
    return {
        status: "valid",
        marker: { schemaVersion: 1, mode: "legacy-shared", profileIds: [...new Set(record.profileIds)] },
    }
}

async function writeLegacySharedMarker(filePath: string, profileIds: string[]): Promise<void> {
    const marker: LegacySharedMarker = { schemaVersion: 1, mode: "legacy-shared", profileIds }
    // The marker sits among credentials, so it keeps their owner-only permission.
    await writeJsonAtomic(filePath, marker, { mode: 0o600 })
}

async function unlinkIfExists(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
    })
}

export class OpenAiCodexProfileAuthMigration {
    private readonly repository: OpenAiCodexProfileAuthRepository
    private readonly lock = new FileLock()
    private readonly legacyPath: string
    private readonly markerPath: string

    constructor(options: OpenAiCodexProfileAuthMigrationOptions) {
        this.repository = options.repository ?? new OpenAiCodexProfileAuthRepository({ secretsDir: options.secretsDir })
        this.legacyPath = getLegacyOpenAiCodexAuthPath(options.secretsDir)
        this.markerPath = getLegacyOpenAiCodexAuthMigrationPath(options.secretsDir)
    }

    async migrate(profiles: readonly OAuthProfileIdentity[]): Promise<OpenAiCodexProfileAuthMigrationResult> {
        await fs.mkdir(this.repository.secretsDir, { recursive: true })
        return this.lock.withLock(this.legacyPath, async () => {
            const legacy = await readLegacyCredential(this.legacyPath)
            if (legacy === "missing") {
                await unlinkIfExists(this.markerPath)
                return { status: "missing-legacy" }
            }
            if (legacy === "malformed") return { status: "malformed-legacy" }

            const profileIds = [
                ...new Set(
                    profiles
                        .filter((profile) => profile.provider === "openai-codex" && profile.id.length > 0)
                        .map(({ id }) => id),
                ),
            ]
            const marker = await readLegacySharedMarker(this.markerPath)
            if (marker.status === "malformed") return { status: "malformed-marker" }
            if (marker.status === "valid") return this.resolveLegacyShared(marker.marker.profileIds, new Set(profileIds))
            if (profileIds.length === 0) return { status: "unassigned-legacy" }
            if (profileIds.length > 1) {
                const unresolvedProfileIds = await this.findUnresolvedProfileIds(profileIds, new Set(profileIds))
                if (unresolvedProfileIds.length === 0) return this.retireLegacyShared()
                await writeLegacySharedMarker(this.markerPath, profileIds)
                return { status: "legacy-shared", profileIds: unresolvedProfileIds }
            }

            const profileId = profileIds[0]
            const saved = await this.repository.importLegacyIfMissing(profileId, legacy.raw)
            if (saved === "malformed") return { status: "destination-malformed", profileId }
            await unlinkIfExists(this.legacyPath)
            return { status: saved === "saved" ? "migrated" : "already-isolated", profileId }
        })
    }

    private async resolveLegacyShared(
        historicalProfileIds: readonly string[],
        currentProfileIds: ReadonlySet<string>,
    ): Promise<OpenAiCodexProfileAuthMigrationResult> {
        const unresolvedProfileIds = await this.findUnresolvedProfileIds(historicalProfileIds, currentProfileIds)
        return unresolvedProfileIds.length === 0
            ? this.retireLegacyShared()
            : { status: "legacy-shared", profileIds: unresolvedProfileIds }
    }

    private async findUnresolvedProfileIds(
        historicalProfileIds: readonly string[],
        currentProfileIds: ReadonlySet<string>,
    ): Promise<string[]> {
        const unresolvedProfileIds: string[] = []
        for (const profileId of historicalProfileIds) {
            if (!currentProfileIds.has(profileId)) continue
            if ((await this.repository.read(profileId)).status !== "valid") unresolvedProfileIds.push(profileId)
        }
        return unresolvedProfileIds
    }

    private async retireLegacyShared(): Promise<OpenAiCodexProfileAuthMigrationResult> {
        await unlinkIfExists(this.legacyPath)
        await unlinkIfExists(this.markerPath)
        return { status: "legacy-retired" }
    }
}
