import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Command, createInitialTaskState } from "../../kernel"
import { FileTaskStateVault } from "../FileTaskStateVault"

const directories: string[] = []

async function directory(): Promise<string> {
    const created = await mkdtemp(path.join(tmpdir(), "dline-runtime-"))
    directories.push(created)
    return created
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

describe("file runtime stores", () => {
    it("atomically restores state and outbox together", async () => {
        const root = await directory()
        const vault = new FileTaskStateVault(path.join(root, "state.json"))
        const command: Command = {
            type: "compose.round",
            commandId: "command-1",
            originRevision: 1,
            generation: 0,
            admittedEntryIds: ["entry-1"],
        }
        await vault.save({ state: { ...createInitialTaskState("task-1"), revision: 1 }, outbox: [command] })
        await expect(new FileTaskStateVault(path.join(root, "state.json")).load("task-1")).resolves.toMatchObject({
            state: { taskId: "task-1", revision: 1 },
            outbox: [command],
        })
    })

    it("keeps the previous snapshot as state.json.bak and restores it when state.json is torn", async () => {
        const root = await directory()
        const stateFile = path.join(root, "state.json")
        const vault = new FileTaskStateVault(stateFile)
        await vault.save({ state: { ...createInitialTaskState("task-1"), revision: 1 }, outbox: [] })
        await vault.save({ state: { ...createInitialTaskState("task-1"), revision: 2 }, outbox: [] })

        expect((await readdir(root)).sort()).toEqual(["state.json", "state.json.bak"])
        expect(await readFile(path.join(root, "state.json"), "utf8")).toMatch(/^\{\n {2}"version": 1,\n[\s\S]*\}\n$/)

        await writeFile(stateFile, '{ "version": 1, "snap')
        await expect(new FileTaskStateVault(stateFile).load("task-1")).resolves.toMatchObject({
            state: { taskId: "task-1", revision: 1 },
        })

        await rm(stateFile)
        await expect(new FileTaskStateVault(stateFile).load("task-1")).resolves.toMatchObject({
            state: { taskId: "task-1", revision: 1 },
        })
    })

    it("does not load a snapshot that belongs to another task", async () => {
        const stateFile = path.join(await directory(), "state.json")
        await new FileTaskStateVault(stateFile).save({ state: { ...createInitialTaskState("task-1"), revision: 1 }, outbox: [] })

        await expect(new FileTaskStateVault(stateFile).load("task-2")).rejects.toThrow("TaskStateVaultIdentityMismatch")
    })
})
