import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveDraftForReceiver } from "@core/task/interaction/DraftAttachments"
import type { AdmittedInputPart, AdmittedResourcePart } from "@shared/input-semantics/admitted-parts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type InputResourceRecord, InputResourceStore, referenceOf } from "../InputResourceStore"
import { StoreDraftAttachments } from "../StoreDraftAttachments"

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
)

let workspace: string

beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "dline-draft-attachments-"))
})

afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
})

async function openStore(): Promise<InputResourceStore> {
    const directory = await fs.mkdtemp(path.join(workspace, "root-"))
    return new InputResourceStore({
        owner: { kind: "task", taskId: "task-draft" },
        resourceDirectory: (resourceId) => path.join(directory, resourceId),
    })
}

async function sourceFile(name: string, content: string): Promise<string> {
    const directory = await fs.mkdtemp(path.join(workspace, "source-"))
    const filePath = path.join(directory, name)
    await fs.writeFile(filePath, content)
    return filePath
}

function recordOf(result: { ok: true; value: InputResourceRecord } | { ok: false; failure: unknown }): InputResourceRecord {
    if (!result.ok) throw new Error(`expected a record, got ${JSON.stringify(result.failure)}`)
    return result.value
}

function partOf(record: InputResourceRecord, nodeKind: AdmittedResourcePart["nodeKind"]): AdmittedResourcePart {
    return {
        kind: "resource",
        entityId: `entity-${record.resourceId}`,
        nodeKind,
        ref: referenceOf(record),
        displayName: record.displayName,
    }
}

describe("StoreDraftAttachments", () => {
    it("hands a receiver the verified image bytes and the linked file's own path, in part order", async () => {
        const store = await openStore()
        const image = partOf(recordOf(await store.stageBytes("shot.png", PNG_1X1)), "image")
        const source = await sourceFile("notes.md", "# notes\n")
        const file = partOf(recordOf(await store.linkFile(source)), "file")

        const resolved = await new StoreDraftAttachments(() => store).resolve([{ kind: "text", text: "see " }, image, file])

        expect(resolved.images).toEqual([`data:image/png;base64,${PNG_1X1.toString("base64")}`])
        expect(resolved.files).toEqual([path.resolve(source)])
        expect(resolved.notices).toEqual([])
    })

    it("names a resource that can no longer be read instead of handing on nothing", async () => {
        const store = await openStore()
        const source = await sourceFile("gone.md", "# gone\n")
        const file = partOf(recordOf(await store.linkFile(source)), "file")
        await fs.rm(source)

        const resolved = await new StoreDraftAttachments(() => store).resolve([file])

        expect(resolved.files).toEqual([])
        expect(resolved.notices).toHaveLength(1)
        expect(resolved.notices[0]).toContain('"gone.md"')
        expect(resolved.notices[0]).not.toContain(source)
    })
})

describe("resolveDraftForReceiver", () => {
    const resource: AdmittedResourcePart = {
        kind: "resource",
        entityId: "image-1",
        nodeKind: "image",
        ref: {
            resourceId: "res-1",
            expectedContentHash: "sha256:00",
            mediaType: "image/png",
            byteLength: 1,
            owner: { kind: "task", taskId: "task-draft" },
            generation: 1,
        },
        displayName: "shot.png",
    }

    it("returns a draft without resource parts unchanged", async () => {
        const draft = { text: "plain", images: ["data:image/png;base64,AA=="], files: [] }
        const parts: AdmittedInputPart[] = [{ kind: "text", text: "plain" }]

        expect(await resolveDraftForReceiver(draft, undefined)).toBe(draft)
        expect(await resolveDraftForReceiver({ ...draft, admittedParts: parts }, undefined)).toEqual({
            ...draft,
            admittedParts: parts,
        })
    })

    it("hands on the parts as named text with resolved attachments after any legacy ones, and drops the parts", async () => {
        const draft = {
            text: "look [image:res-1]",
            images: ["data:image/png;base64,AA=="],
            files: [],
            admittedParts: [{ kind: "text", text: "look " }, resource] as const,
        }
        const port = {
            resolve: async () => ({ images: ["data:image/png;base64,AQ=="], files: [], notices: ["[missing]"] }),
        }

        const resolved = await resolveDraftForReceiver(draft, port)

        expect(resolved.images).toEqual(["data:image/png;base64,AA==", "data:image/png;base64,AQ=="])
        expect(resolved.text).toBe("look [shot.png]\n[missing]")
        expect(resolved.admittedParts).toBeUndefined()
    })

    it("says every resource is unavailable when there is no store to read it from", async () => {
        const resolved = await resolveDraftForReceiver({ text: "", images: [], files: [], admittedParts: [resource] }, undefined)

        expect(resolved.images).toEqual([])
        expect(resolved.text).toBe(
            '[shot.png]\n[The attached resource "shot.png" is unavailable: semantic_input_resource_open_failed]',
        )
    })

    it("reports every resource as unavailable instead of rejecting when the store fails", async () => {
        const port = {
            resolve: async (): Promise<never> => {
                throw new Error("store closed")
            },
        }

        const resolved = await resolveDraftForReceiver({ text: "", images: [], files: [], admittedParts: [resource] }, port)

        expect(resolved.images).toEqual([])
        expect(resolved.files).toEqual([])
        expect(resolved.text).toContain('[The attached resource "shot.png" is unavailable: semantic_input_resource_open_failed]')
    })
})
