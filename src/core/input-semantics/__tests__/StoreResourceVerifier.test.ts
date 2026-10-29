import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
    FileNodeOrigin,
    InputResourceOwner,
    SemanticInputDocument,
    SemanticResourceRef,
} from "@shared/input-semantics/document"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { InputResourceStore, referenceOf } from "../InputResourceStore"
import { StoreResourceVerifier } from "../StoreResourceVerifier"

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
)
const TASK_OWNER: InputResourceOwner = { kind: "task", taskId: "task-a" }

let workspace: string

beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "dline-resource-verifier-"))
})

afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
})

async function openStore(owner: InputResourceOwner = TASK_OWNER): Promise<{ store: InputResourceStore; directory: string }> {
    const directory = await fs.mkdtemp(path.join(workspace, "root-"))
    return { store: new InputResourceStore({ owner, resourceDirectory: (id) => path.join(directory, id) }), directory }
}

function staged<T>(result: { ok: true; value: T } | { ok: false; failure: unknown }): T {
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
    return result.value
}

function documentWith(
    kind: "image" | "file",
    ref: SemanticResourceRef,
    fileOrigin: FileNodeOrigin = "uploaded_file",
): SemanticInputDocument {
    const node =
        kind === "image"
            ? { kind, entityId: "doc-1#r", resourceId: ref.resourceId, displayName: "item" }
            : { kind, entityId: "doc-1#r", resourceId: ref.resourceId, displayName: "item", fileOrigin }
    return {
        schemaVersion: 1,
        parserVersion: "1.1.0",
        catalogRevision: "1",
        documentId: "doc-1",
        rawText: "",
        nodes: [node],
        resources: [ref],
    } as SemanticInputDocument
}

async function verify(store: InputResourceStore, document: SemanticInputDocument) {
    const node = document.nodes[0]
    if (node?.kind !== "image" && node?.kind !== "file") throw new Error("expected a resource node")
    return new StoreResourceVerifier(() => store).verify(document, node)
}

describe("StoreResourceVerifier", () => {
    it("accepts an owned, unchanged image behind an image node", async () => {
        const { store } = await openStore()
        const record = staged(await store.stageBytes("shot.png", PNG_1X1))

        expect(await verify(store, documentWith("image", referenceOf(record)))).toEqual([])
    })

    it("locates a changed resource on its node", async () => {
        const { store, directory } = await openStore()
        const record = staged(await store.stageText("frozen"))
        await fs.writeFile(path.join(directory, record.resourceId, record.fileName), "edited")

        const diagnostics = await verify(store, documentWith("file", referenceOf(record)))

        expect(diagnostics.map((d) => [d.code, d.entityId, d.resourceId])).toEqual([
            ["semantic_input_resource_changed", "doc-1#r", record.resourceId],
        ])
        expect(diagnostics[0].message).not.toContain(directory)
    })

    it("refuses a resource another owner holds", async () => {
        const { store: other } = await openStore({ kind: "draft", draftId: "draft-a" })
        const record = staged(await other.stageText("not yours"))
        const { store } = await openStore()

        const diagnostics = await verify(store, documentWith("file", referenceOf(record)))

        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0].code).toMatch(/^semantic_input_resource_/)
    })

    it("refuses an image node backed by text and a file node backed by an image", async () => {
        const { store } = await openStore()
        const text = staged(await store.stageText("plain"))
        const image = staged(await store.stageBytes("shot.png", PNG_1X1))

        expect((await verify(store, documentWith("image", referenceOf(text)))).map((d) => d.code)).toEqual([
            "semantic_input_resource_invalid_mime",
        ])
        expect((await verify(store, documentWith("file", referenceOf(image)))).map((d) => d.code)).toEqual([
            "semantic_input_resource_invalid",
        ])
    })

    // Pasted text and a stored file render differently in the chat row, so a
    // node may only claim the origin its staged resource actually has.
    it("requires a file node's origin to match how its resource was staged", async () => {
        const { store } = await openStore()
        const pasted = staged(await store.stageText("typed by the user"))
        const uploaded = staged(await store.stageBytes("notes.txt", Buffer.from("from disk")))

        expect(await verify(store, documentWith("file", referenceOf(pasted), "pasted_text"))).toEqual([])
        expect(await verify(store, documentWith("file", referenceOf(uploaded), "pasted_file"))).toEqual([])
        expect((await verify(store, documentWith("file", referenceOf(pasted), "uploaded_file"))).map((d) => d.code)).toEqual([
            "semantic_input_resource_invalid",
        ])
        expect((await verify(store, documentWith("file", referenceOf(uploaded), "pasted_text"))).map((d) => d.code)).toEqual([
            "semantic_input_resource_invalid",
        ])
    })
})
