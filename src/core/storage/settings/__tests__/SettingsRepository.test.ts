import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SettingsRepository } from "../SettingsRepository"

const temporaryDirectories: string[] = []
const repositories: SettingsRepository[] = []

async function createSettingsFile(initial: Record<string, unknown> = {}): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-settings-repository-"))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, "settings.json")
    await fs.writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8")
    return filePath
}

async function openRepository(filePath: string, sourceId: string, watch = false): Promise<SettingsRepository> {
    const repository = new SettingsRepository({ filePath, sourceId, watch })
    repositories.push(repository)
    await repository.initialize()
    return repository
}

async function readDocument(filePath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for Settings repository condition")
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
}

afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.dispose()))
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("SettingsRepository", () => {
    it("merges concurrent updates to different keys from the latest disk snapshot", async () => {
        const filePath = await createSettingsFile({
            chatInputSendShortcut: "enter",
            terminalOutputLineLimit: 500,
        })
        const left = await openRepository(filePath, "left")
        const right = await openRepository(filePath, "right")

        await Promise.all([left.mutate({ chatInputSendShortcut: "ctrlEnter" }), right.mutate({ terminalOutputLineLimit: 900 })])

        const document = await readDocument(filePath)
        expect(document.chatInputSendShortcut).toBe("ctrlEnter")
        expect(document.terminalOutputLineLimit).toBe(900)
        expect(document.__settingsRepositoryRevision).toBe(2)
    })

    it("keeps the final same-key value aligned with the higher committed revision", async () => {
        const filePath = await createSettingsFile({ chatInputSendShortcut: "enter" })
        const left = await openRepository(filePath, "left")
        const right = await openRepository(filePath, "right")

        const [leftCommit, rightCommit] = await Promise.all([
            left.mutate({ chatInputSendShortcut: "ctrlEnter" }),
            right.mutate({ chatInputSendShortcut: "shiftEnter" }),
        ])
        const document = await readDocument(filePath)
        const winningCommit = leftCommit.revision > rightCommit.revision ? leftCommit : rightCommit

        expect(leftCommit.revision).not.toBe(rightCommit.revision)
        expect(document.__settingsRepositoryRevision).toBe(winningCommit.revision)
        expect(document.chatInputSendShortcut).toBe(winningCommit.snapshot.values.chatInputSendShortcut)
    })

    it("publishes an external committed snapshot through the watcher", async () => {
        const filePath = await createSettingsFile({ chatInputSendShortcut: "enter" })
        const writer = await openRepository(filePath, "writer")
        const reader = await openRepository(filePath, "reader", true)
        const commits: Array<{ revision: number; shortcut: unknown }> = []
        reader.subscribe((commit) => {
            commits.push({
                revision: commit.revision,
                shortcut: commit.snapshot.values.chatInputSendShortcut,
            })
        })

        const writeCommit = await writer.mutate({ chatInputSendShortcut: "ctrlEnter" })
        await waitFor(() => commits.some((commit) => commit.revision === writeCommit.revision))

        expect(reader.readSnapshot().values.chatInputSendShortcut).toBe("ctrlEnter")
        expect(commits).toContainEqual({ revision: writeCommit.revision, shortcut: "ctrlEnter" })
    })

    it("does not partially commit an invalid composite patch", async () => {
        const filePath = await createSettingsFile({
            chatInputSendShortcut: "enter",
            autoCondenseTriggerPercent: 80,
        })
        const repository = await openRepository(filePath, "writer")
        const before = await readDocument(filePath)

        await expect(
            repository.mutate({
                chatInputSendShortcut: "ctrlEnter",
                autoCondenseTriggerPercent: 0,
            }),
        ).rejects.toThrow(/trigger must be an integer/i)

        expect(await readDocument(filePath)).toEqual(before)
        expect(repository.readSnapshot().revision).toBe(0)
    })

    it("reads legacy flat Settings and preserves the flat shape on the first commit", async () => {
        const filePath = await createSettingsFile({
            __settingsMigrationVersion: 1,
            chatInputSendShortcut: "shiftEnter",
            terminalOutputLineLimit: 700,
        })
        const repository = await openRepository(filePath, "writer")

        expect(repository.readSnapshot().values.chatInputSendShortcut).toBe("shiftEnter")
        expect(repository.readSnapshot().values.terminalOutputLineLimit).toBe(700)

        await repository.mutate({ chatInputSendShortcut: "ctrlEnter" })
        const document = await readDocument(filePath)
        expect(document.chatInputSendShortcut).toBe("ctrlEnter")
        expect(document.terminalOutputLineLimit).toBe(700)
        expect(document.values).toBeUndefined()
        expect(document.__settingsRepositorySchemaVersion).toBe(1)
    })
})
