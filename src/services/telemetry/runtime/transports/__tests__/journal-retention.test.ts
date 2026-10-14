import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { enforceJournalRetention, MAX_AGE_DAYS, MAX_SESSIONS } from "../journal-retention"

/**
 * Retention deletes from a user data directory, so these tests pin the exact
 * deletion set: which files go, which stay, and what is never touched.
 */

const NOW = 1_700_000_000_000
const MS_PER_DAY = 24 * 60 * 60 * 1000

let directory: string

async function writeJournal(name: string, ageDays: number): Promise<void> {
    const path = join(directory, name)
    await writeFile(path, "{}\n", "utf8")
    const modified = new Date(NOW - ageDays * MS_PER_DAY)
    await utimes(path, modified, modified)
}

async function remaining(): Promise<string[]> {
    return (await readdir(directory)).sort()
}

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dline-retention-"))
})

afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
})

describe("journal retention defaults", () => {
    it("bounds collector-less history to eight recent sessions over three days", () => {
        expect(MAX_SESSIONS).toBe(8)
        expect(MAX_AGE_DAYS).toBe(3)
    })
})

describe("journal retention by count", () => {
    it("keeps every journal when the directory is exactly at the limit", async () => {
        for (let index = 0; index < 3; index++) {
            await writeJournal(`session-${index}.jsonl`, index)
        }

        const result = await enforceJournalRetention({ directory, maxSessions: 3, now: () => NOW })

        expect(result.deleted).toBe(0)
        expect(await remaining()).toHaveLength(3)
    })

    it("drops the oldest journals once the limit is exceeded", async () => {
        await writeJournal("newest.jsonl", 0)
        await writeJournal("middle.jsonl", 1)
        await writeJournal("oldest.jsonl", 2)

        const result = await enforceJournalRetention({ directory, maxSessions: 2, now: () => NOW })

        expect(result.deleted).toBe(1)
        expect(await remaining()).toEqual(["middle.jsonl", "newest.jsonl"])
    })
})

describe("journal retention by age", () => {
    it("removes expired journals even when the count is under the limit", async () => {
        await writeJournal("recent.jsonl", 1)
        await writeJournal("expired.jsonl", 31)

        const result = await enforceJournalRetention({ directory, maxAgeDays: 30, now: () => NOW })

        expect(result.deleted).toBe(1)
        expect(await remaining()).toEqual(["recent.jsonl"])
    })

    it("keeps a journal sitting exactly on the age boundary", async () => {
        await writeJournal("boundary.jsonl", 30)

        const result = await enforceJournalRetention({ directory, maxAgeDays: 30, now: () => NOW })

        expect(result.deleted).toBe(0)
        expect(await remaining()).toEqual(["boundary.jsonl"])
    })
})

describe("journal retention boundaries", () => {
    it("never deletes the journal of the run in progress", async () => {
        // Oldest by mtime, so it would be evicted if it were eligible.
        await writeJournal("active.jsonl", 99)
        await writeJournal("other.jsonl", 0)

        const result = await enforceJournalRetention({
            directory,
            activeSessionId: "active",
            maxSessions: 1,
            maxAgeDays: 30,
            now: () => NOW,
        })

        expect(await remaining()).toContain("active.jsonl")
        expect(result.deleted).toBe(0)
    })

    it("ignores files that are not session journals", async () => {
        await writeFile(join(directory, "notes.txt"), "keep me", "utf8")
        await writeFile(join(directory, "config.json"), "{}", "utf8")
        await writeJournal("session.jsonl", 99)

        await enforceJournalRetention({ directory, maxAgeDays: 30, now: () => NOW })

        expect(await remaining()).toEqual(["config.json", "notes.txt"])
    })

    it("reports nothing to do when the directory does not exist", async () => {
        const result = await enforceJournalRetention({ directory: join(directory, "absent"), now: () => NOW })

        expect(result).toEqual({ deleted: 0, retained: 0, failed: 0 })
    })
})
