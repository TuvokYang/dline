import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MetricsRepository } from "../MetricsRepository"
import type { MetricsScope } from "../MetricsScope"
import {
    type LegacyDailyEntry,
    type LegacyDailySource,
    legacySubjectKey,
    migrateLegacyDailyUsage,
} from "../MigrationLegacyDailyUsage"

function source(entries: readonly LegacyDailyEntry[]): LegacyDailySource {
    return {
        async read() {
            return entries
        },
    }
}

describe("migrateLegacyDailyUsage", () => {
    let root: string
    const repositories: MetricsRepository[] = []

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "metrics-migration-"))
    })

    afterEach(async () => {
        await Promise.allSettled(repositories.splice(0).map((repository) => repository.close()))
        await fs.rm(root, { recursive: true, force: true })
    })

    async function repository(): Promise<MetricsRepository> {
        const scope: MetricsScope = { level: "global", scopeId: "", databasePath: path.join(root, "global.db") }
        const created = await MetricsRepository.open({ scope })
        repositories.push(created)
        return created
    }

    it("freezes the inclusive legacy total instead of splitting it", async () => {
        const target = await repository()
        const result = await migrateLegacyDailyUsage({
            source: source([{ profileId: "profile-a", day: "2026-01-02", inputTokens: 100, outputTokens: 40 }]),
            repository: target,
        })

        expect(result).toEqual({ migrated: 1, skipped: 0, alreadyMigrated: false })
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-02"))).toEqual({
            subjectKey: legacySubjectKey("profile-a", "2026-01-02"),
            inputTokens: 100,
            outputTokens: 40,
        })
        // The migration must not create a usage row: the old number is not fresh input,
        // so writing it as one would double-count the cached part.
        expect(await target.usage()).toEqual([])
    })

    it("does not import the same day twice after a restart", async () => {
        const entries: LegacyDailyEntry[] = [{ profileId: "profile-a", day: "2026-01-02", inputTokens: 100, outputTokens: 40 }]
        const first = await repository()
        await migrateLegacyDailyUsage({ source: source(entries), repository: first })

        // A second start on a fresh handle reads the same marker from disk.
        const second = await repository()
        const result = await migrateLegacyDailyUsage({ source: source(entries), repository: second })

        expect(result).toEqual({ migrated: 0, skipped: 1, alreadyMigrated: true })
        expect(await second.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-02"))).toMatchObject({
            inputTokens: 100,
        })
    })

    it("migrates each Profile and day as its own subject", async () => {
        const target = await repository()
        const result = await migrateLegacyDailyUsage({
            source: source([
                { profileId: "profile-a", day: "2026-01-02", inputTokens: 10, outputTokens: 1 },
                { profileId: "profile-b", day: "2026-01-02", inputTokens: 20, outputTokens: 2 },
                { profileId: "profile-a", day: "2026-01-03", inputTokens: 30, outputTokens: 3 },
            ]),
            repository: target,
        })

        expect(result.migrated).toBe(3)
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-02"))).toMatchObject({
            inputTokens: 10,
        })
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-b", "2026-01-02"))).toMatchObject({
            inputTokens: 20,
        })
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-03"))).toMatchObject({
            inputTokens: 30,
        })
    })

    it("does nothing when the old ledger is empty", async () => {
        const target = await repository()
        expect(await migrateLegacyDailyUsage({ source: source([]), repository: target })).toEqual({
            migrated: 0,
            skipped: 0,
            alreadyMigrated: false,
        })
    })

    // `clearAll` drops the frozen numbers with the rows and keeps only the marker, so a
    // migration that asked for the baseline would see "never imported" and write the
    // cleared usage back. The marker is the reason the numbers stay gone.
    it("does not resurrect cleared legacy numbers after clearAll", async () => {
        const target = await repository()
        const entries = [{ profileId: "profile-a", day: "2026-01-02", inputTokens: 100, outputTokens: 40 }] as const
        await migrateLegacyDailyUsage({ source: source(entries), repository: target })

        await target.clearAll()
        // The baseline is gone, which is exactly why the marker has to decide.
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-02"))).toBeUndefined()
        expect(await target.hasLegacyImport(legacySubjectKey("profile-a", "2026-01-02"))).toBe(true)

        const replay = await migrateLegacyDailyUsage({ source: source(entries), repository: target })
        expect(replay).toEqual({ migrated: 0, skipped: 1, alreadyMigrated: true })
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-02"))).toBeUndefined()
    })

    it("keeps the marker and clears the numbers on a full usage clear", async () => {
        const target = await repository()
        await migrateLegacyDailyUsage({
            source: source([{ profileId: "profile-a", day: "2026-01-02", inputTokens: 100, outputTokens: 40 }]),
            repository: target,
        })

        await target.clear({ tables: ["usage"], releaseLegacyBaseline: true })
        expect(await target.readLegacyBaseline(legacySubjectKey("profile-a", "2026-01-02"))).toMatchObject({
            inputTokens: 0,
            outputTokens: 0,
        })

        const replay = await migrateLegacyDailyUsage({
            source: source([{ profileId: "profile-a", day: "2026-01-02", inputTokens: 100, outputTokens: 40 }]),
            repository: target,
        })
        // The marker survives, so the cleared legacy number is not resurrected.
        expect(replay).toEqual({ migrated: 0, skipped: 1, alreadyMigrated: true })
    })
})
