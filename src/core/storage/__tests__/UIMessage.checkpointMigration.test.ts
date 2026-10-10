import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { UIMessage } from "../UIMessage"

let tempRoot: string | undefined
let previousDocsRoot: string | undefined

afterEach(async () => {
    if (previousDocsRoot === undefined) delete process.env.DLINE_DOCS_DIR
    else process.env.DLINE_DOCS_DIR = previousDocsRoot
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
    previousDocsRoot = undefined
})

describe("UIMessage checkpoint reference migration", () => {
    it("promotes a persisted scalar checkpoint hash to a single-element reference set", async () => {
        previousDocsRoot = process.env.DLINE_DOCS_DIR
        tempRoot = await mkdtemp(path.join(os.tmpdir(), "dline-ui-checkpoint-migration-"))
        process.env.DLINE_DOCS_DIR = tempRoot
        const taskId = "legacy-checkpoint-task"
        const taskDirectory = path.join(tempRoot, "tasks", taskId)
        await mkdir(taskDirectory, { recursive: true })
        await writeFile(
            path.join(taskDirectory, "ui_messages.jsonl"),
            `${JSON.stringify({ ts: 1, type: "say", say: "checkpoint_created", lastCheckpointHash: "legacy-hash" })}\n`,
            "utf8",
        )

        const store = await UIMessage.open(taskId)
        expect(store.getAll()[0]?.lastCheckpointHash).toEqual(["legacy-hash"])
        await store.close()

        // The legacy file is retired only after the promoted rows are committed to messages.db.
        await expect(access(path.join(taskDirectory, "ui_messages.jsonl.migrated"))).resolves.toBeUndefined()
        const reopened = await UIMessage.open(taskId)
        expect(reopened.getAll()[0]?.lastCheckpointHash).toEqual(["legacy-hash"])
        await reopened.close()
    })
})
