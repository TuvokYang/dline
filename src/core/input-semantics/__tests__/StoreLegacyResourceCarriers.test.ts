import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AdmittedResourcePart } from "@shared/input-semantics/admitted-parts"
import type { InputResourceOwner } from "@shared/input-semantics/document"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SemanticInputRejectedError } from "@/core/task/session/TaskInputAdmission"
import { type InputResourceRecord, InputResourceStore, referenceOf } from "../InputResourceStore"
import { StoreLegacyResourceCarriers } from "../StoreLegacyResourceCarriers"

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
)
const TASK_OWNER: InputResourceOwner = { kind: "task", taskId: "task-carriers" }

let workspace: string

beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "dline-resource-carriers-"))
})

afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
})

async function openStore(): Promise<{ store: InputResourceStore; directory: string }> {
    const directory = await fs.mkdtemp(path.join(workspace, "task-"))
    return {
        store: new InputResourceStore({ owner: TASK_OWNER, resourceDirectory: (id) => path.join(directory, id) }),
        directory,
    }
}

function staged(result: Awaited<ReturnType<InputResourceStore["stageText"]>>): InputResourceRecord {
    if (!result.ok) throw new Error(result.failure.message)
    return result.value
}

function partOf(record: InputResourceRecord, nodeKind: "image" | "file"): AdmittedResourcePart {
    return {
        kind: "resource",
        entityId: `e-${record.resourceId}`,
        nodeKind,
        ref: referenceOf(record),
        displayName: record.displayName,
    }
}

describe("StoreLegacyResourceCarriers", () => {
    it("hands an image on as a data URL of the verified bytes and a file as the task's own copy", async () => {
        const { store, directory } = await openStore()
        const image = staged(await store.stageBytes("shot.png", PNG_1X1))
        const text = staged(await store.stageText("pasted text"))

        const carried = await new StoreLegacyResourceCarriers(() => store).project("doc-1", [
            partOf(image, "image"),
            partOf(text, "file"),
        ])

        expect(carried.images).toEqual([`data:image/png;base64,${PNG_1X1.toString("base64")}`])
        expect(carried.files).toEqual([path.join(directory, text.resourceId, text.fileName)])
        expect(await fs.readFile(carried.files[0], "utf8")).toBe("pasted text")
    })

    it("refuses a resource whose bytes changed after staging, naming it", async () => {
        const { store, directory } = await openStore()
        const text = staged(await store.stageText("original"))
        await fs.writeFile(path.join(directory, text.resourceId, text.fileName), "changed behind the composer")

        const carried = new StoreLegacyResourceCarriers(() => store).project("doc-2", [partOf(text, "file")])

        await expect(carried).rejects.toBeInstanceOf(SemanticInputRejectedError)
        await expect(carried).rejects.toMatchObject({
            diagnostics: [{ code: "semantic_input_resource_changed", documentId: "doc-2", resourceId: text.resourceId }],
        })
    })
})
