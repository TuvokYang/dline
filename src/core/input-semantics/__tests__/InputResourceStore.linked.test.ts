import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_ATTACHED_TEXT_FILE_BYTES } from "@shared/attachments"
import type { InputResourceOwner } from "@shared/input-semantics/document"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { INPUT_RESOURCE_RECORD_FILE, type InputResourceRoot, InputResourceStore, referenceOf } from "../InputResourceStore"

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
)
const DRAFT_OWNER: InputResourceOwner = { kind: "draft", draftId: "draft-linked" }
const TASK_OWNER: InputResourceOwner = { kind: "task", taskId: "task-linked" }

let workspace: string

beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "dline-linked-resource-"))
})

afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
})

async function openStore(owner: InputResourceOwner = DRAFT_OWNER): Promise<{ store: InputResourceStore; directory: string }> {
    const directory = await fs.mkdtemp(path.join(workspace, "root-"))
    const root: InputResourceRoot = { owner, resourceDirectory: (resourceId) => path.join(directory, resourceId) }
    return { store: new InputResourceStore(root), directory }
}

async function sourceFile(name: string, content: string | Buffer): Promise<string> {
    const directory = await fs.mkdtemp(path.join(workspace, "source-"))
    const filePath = path.join(directory, name)
    await fs.writeFile(filePath, content)
    return filePath
}

function value<T>(result: { ok: true; value: T } | { ok: false; failure: unknown }): T {
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
    return result.value
}

function failureCode(result: { ok: true } | { ok: false; failure: { code: string } }): string | undefined {
    return result.ok ? undefined : result.failure.code
}

describe("InputResourceStore linked local files", () => {
    it("links a picked file by its real path without copying its content", async () => {
        const { store, directory } = await openStore()
        const source = await sourceFile("notes.md", "# first\n")

        const record = value(await store.linkFile(source))

        expect(record.linkedPath).toBe(await fs.realpath(source))
        expect(record.displayName).toBe("notes.md")
        expect(record.mediaType).toBe("text/markdown")
        expect(await fs.readdir(path.join(directory, record.resourceId))).toEqual([INPUT_RESOURCE_RECORD_FILE])
    })

    it("reads what the file holds when it is used, not what it held when linked", async () => {
        const { store } = await openStore()
        const source = await sourceFile("notes.md", "# first\n")
        const ref = referenceOf(value(await store.linkFile(source)))

        await fs.writeFile(source, "# edited afterwards\n")

        expect(value(await store.readBytes(ref)).bytes.toString("utf8")).toBe("# edited afterwards\n")
        expect(value(await store.resolve(ref)).contentPath).toBe(await fs.realpath(source))
    })

    it("keeps reading the file it linked when the link it was picked through is pointed elsewhere", async () => {
        const { store } = await openStore()
        const first = path.dirname(await sourceFile("notes.md", "# first\n"))
        const second = path.dirname(await sourceFile("notes.md", "# second\n"))
        const via = path.join(workspace, `via-${path.basename(first)}`)
        // A junction needs no privilege on Windows and is a directory symlink elsewhere.
        await fs.symlink(first, via, "junction")
        const ref = referenceOf(value(await store.linkFile(path.join(via, "notes.md"))))

        await fs.unlink(via)
        await fs.symlink(second, via, "junction")

        expect(value(await store.readBytes(ref)).bytes.toString("utf8")).toBe("# first\n")
    })

    it("reports a linked file whose real path now leads through a link to another file as changed", async () => {
        const { store } = await openStore()
        const first = path.dirname(await sourceFile("notes.md", "# first\n"))
        const second = path.dirname(await sourceFile("notes.md", "# second\n"))
        const ref = referenceOf(value(await store.linkFile(path.join(first, "notes.md"))))

        await fs.rename(first, `${first}-moved`)
        await fs.symlink(second, first, "junction")

        expect(failureCode(await store.readBytes(ref))).toBe("semantic_input_resource_changed")
    })

    it("reports a linked file that no longer exists as missing", async () => {
        const { store } = await openStore()
        const source = await sourceFile("gone.txt", "soon gone")
        const ref = referenceOf(value(await store.linkFile(source)))

        await fs.rm(source)

        expect(failureCode(await store.readBytes(ref))).toBe("semantic_input_resource_missing")
    })

    it("reports a linked file that became another media type as changed", async () => {
        const { store } = await openStore()
        const source = await sourceFile("shot.png", PNG_1X1)
        const ref = referenceOf(value(await store.linkFile(source)))

        await fs.writeFile(source, "plain text now")

        expect(failureCode(await store.readBytes(ref))).toBe("semantic_input_resource_changed")
    })

    it("refuses a linked file that grew past its attachment limit without reading it", async () => {
        const { store } = await openStore()
        const source = await sourceFile("big.txt", "small")
        const ref = referenceOf(value(await store.linkFile(source)))

        await fs.writeFile(source, Buffer.alloc(MAX_ATTACHED_TEXT_FILE_BYTES + 1, 0x61))

        expect(failureCode(await store.readBytes(ref))).toBe("semantic_input_resource_too_large")
    })

    it("refuses to link a directory or a file that does not exist", async () => {
        const { store } = await openStore()

        expect(failureCode(await store.linkFile(workspace))).toBe("semantic_input_resource_invalid")
        expect(failureCode(await store.linkFile(path.join(workspace, "absent.txt")))).toBe("semantic_input_resource_missing")
    })

    it("adopts a linked resource as a link, so the task reads the same file", async () => {
        const draft = await openStore(DRAFT_OWNER)
        const task = await openStore(TASK_OWNER)
        const source = await sourceFile("spec.md", "v1")
        const linked = value(await draft.store.linkFile(source))

        const adopted = value(await task.store.adoptFrom(draft.store, referenceOf(linked)))

        expect(adopted.record.owner).toEqual(TASK_OWNER)
        expect(adopted.record.generation).toBe(linked.generation + 1)
        expect(adopted.record.linkedPath).toBe(linked.linkedPath)
        expect(await fs.readdir(path.join(task.directory, linked.resourceId))).toEqual([INPUT_RESOURCE_RECORD_FILE])
        await fs.writeFile(source, "v2")
        expect(value(await task.store.readBytes(referenceOf(adopted.record))).bytes.toString("utf8")).toBe("v2")
    })

    it("removes the link and never the file it names", async () => {
        const { store, directory } = await openStore()
        const source = await sourceFile("keep.txt", "keep me")
        const record = value(await store.linkFile(source))

        expect(value(await store.remove(record.resourceId)).removed).toBe(true)

        await expect(fs.readFile(source, "utf8")).resolves.toBe("keep me")
        await expect(fs.stat(path.join(directory, record.resourceId))).rejects.toThrow()
    })

    it("keeps staging a copied file as a frozen capture", async () => {
        const { store } = await openStore()
        const source = await sourceFile("copied.txt", "frozen")

        const record = value(await store.stageFile(source))
        await fs.writeFile(source, "edited")

        expect(record.linkedPath).toBeUndefined()
        expect(value(await store.readBytes(referenceOf(record))).bytes.toString("utf8")).toBe("frozen")
    })
})
