import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
    type InputResourceOwner,
    SEMANTIC_INPUT_SCHEMA_VERSION,
    type SemanticInputDocument,
    type SemanticResourceRef,
} from "@shared/input-semantics/document"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import { adoptDraftDocument, adoptDraftResources, draftInputResourceRoot, verifyDraftDocument } from "../DraftInputResourceStore"
import { type InputResourceRecord, type InputResourceRoot, InputResourceStore, referenceOf } from "../InputResourceStore"

const DRAFT_OWNER: InputResourceOwner = { kind: "draft", draftId: "welcome-draft" }
const TASK_OWNER: InputResourceOwner = { kind: "task", taskId: "task-created" }

let workspace: string

beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "dline-draft-adoption-"))
})

afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
})

async function storeAt(owner: InputResourceOwner): Promise<{ store: InputResourceStore; directory: string }> {
    const directory = await fs.mkdtemp(path.join(workspace, `${owner.kind}-`))
    const root: InputResourceRoot = {
        owner,
        resourceDirectory: (resourceId) => path.join(directory, resourceId),
    }
    return { store: new InputResourceStore(root), directory }
}

async function staged(store: InputResourceStore, text: string): Promise<InputResourceRecord> {
    const result = await store.stageText(text)
    if (!result.ok) throw new Error(result.failure.message)
    return result.value
}

describe("draftInputResourceRoot", () => {
    it("keeps each draft resource in its own managed attachment directory", () => {
        const root = draftInputResourceRoot("welcome-draft")
        const resourceId = "6f1c1f5e-3c55-4a8e-9a43-0c7b8a1e2d3f"

        expect(root.owner).toEqual(DRAFT_OWNER)
        expect(DlineRuntimeFileManager.isManagedPath(root.resourceDirectory(resourceId))).toBe(true)
        expect(path.basename(root.resourceDirectory(resourceId))).toBe(resourceId)
    })

    it("keeps a draft resource alive in the aging attachment area whenever it is verified", async () => {
        const directory = await fs.mkdtemp(path.join(workspace, "area-"))
        const area = {
            attachmentDirectory: (stableId: string) => path.join(directory, stableId),
            markAttachmentDirectoryRetained: vi.fn(async (_stableId: string) => undefined),
        }
        const draft = new InputResourceStore(draftInputResourceRoot("welcome-draft", area))
        const record = await staged(draft, "still in the composer")

        expect((await draft.resolve(referenceOf(record))).ok).toBe(true)

        expect(area.markAttachmentDirectoryRetained.mock.calls).toEqual([[record.resourceId]])
    })

    it("refuses a draft identity that could address another directory", () => {
        expect(() => draftInputResourceRoot("../escape")).toThrow(/draft/i)
        expect(() => draftInputResourceRoot("")).toThrow(/draft/i)
    })
})

describe("adoptDraftResources", () => {
    it("moves every referenced resource to the task under its identity and a later generation", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: task } = await storeAt(TASK_OWNER)
        const first = await staged(draft, "first block")
        const second = await staged(draft, "second block")

        const result = await adoptDraftResources(draft, task, [referenceOf(first), referenceOf(second)])

        expect(result.ok).toBe(true)
        const adopted = result.ok ? result.value : []
        expect(adopted.map((ref) => ref.resourceId)).toEqual([first.resourceId, second.resourceId])
        expect(adopted.every((ref) => ref.generation === 2)).toBe(true)
        expect(adopted.every((ref) => ref.owner.kind === "task")).toBe(true)
        for (const ref of adopted) {
            expect((await task.resolve(ref)).ok).toBe(true)
        }
    })

    it("adopts nothing when one resource fails verification", async () => {
        const { store: draft, directory: draftDirectory } = await storeAt(DRAFT_OWNER)
        const { store: task, directory: taskDirectory } = await storeAt(TASK_OWNER)
        const intact = await staged(draft, "intact")
        const tampered = await staged(draft, "will change")
        await fs.writeFile(path.join(draftDirectory, tampered.resourceId, tampered.fileName), "changed after staging")

        const result = await adoptDraftResources(draft, task, [referenceOf(intact), referenceOf(tampered)])

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_changed")
        expect(result.ok ? undefined : result.failure.resourceId).toBe(tampered.resourceId)
        expect(await fs.readdir(taskDirectory)).toEqual([])
        expect((await draft.resolve(referenceOf(intact))).ok).toBe(true)
    })

    it("rejects a reference the draft does not own before copying anything", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: other } = await storeAt({ kind: "draft", draftId: "other-draft" })
        const { store: task, directory: taskDirectory } = await storeAt(TASK_OWNER)
        const own = await staged(draft, "own")
        const foreign = await staged(other, "foreign")

        const result = await adoptDraftResources(draft, task, [referenceOf(own), referenceOf(foreign)])

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_invalid")
        expect(await fs.readdir(taskDirectory)).toEqual([])
    })

    it("keeps an adoption an earlier attempt completed when a retry rolls back", async () => {
        const { store: draft, directory: draftDirectory } = await storeAt(DRAFT_OWNER)
        const { store: task } = await storeAt(TASK_OWNER)
        const earlier = await staged(draft, "adopted earlier")
        const firstAttempt = await adoptDraftResources(draft, task, [referenceOf(earlier)])
        const later = await staged(draft, "added later")
        await fs.writeFile(path.join(draftDirectory, later.resourceId, later.fileName), "changed")

        const retry = await adoptDraftResources(draft, task, [referenceOf(earlier), referenceOf(later)])

        expect(retry.ok).toBe(false)
        const kept = firstAttempt.ok ? firstAttempt.value[0] : undefined
        expect(kept && (await task.resolve(kept)).ok).toBe(true)
    })

    it("moves resources only from a draft into a task", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: otherDraft, directory: otherDirectory } = await storeAt({ kind: "draft", draftId: "other-draft" })
        const { store: task } = await storeAt(TASK_OWNER)
        const record = await staged(draft, "draft only")

        const intoDraft = await adoptDraftResources(draft, otherDraft, [referenceOf(record)])
        const fromTask = await adoptDraftResources(task, draft, [referenceOf(record)])

        expect(intoDraft.ok ? undefined : intoDraft.failure.code).toBe("semantic_input_resource_adopt_failed")
        expect(fromTask.ok ? undefined : fromTask.failure.code).toBe("semantic_input_resource_adopt_failed")
        expect(await fs.readdir(otherDirectory)).toEqual([])
    })

    it("adopts a resource referenced twice only once", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: task } = await storeAt(TASK_OWNER)
        const record = await staged(draft, "referenced twice")

        const result = await adoptDraftResources(draft, task, [referenceOf(record), referenceOf(record)])

        expect(result.ok ? result.value.length : 0).toBe(2)
        expect(result.ok ? result.value[0] : undefined).toEqual(result.ok ? result.value[1] : undefined)
    })
})

function documentWith(resources: readonly SemanticResourceRef[]): SemanticInputDocument {
    return {
        schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
        parserVersion: "1.1.0",
        catalogRevision: "1",
        documentId: "doc-opening",
        rawText: "see",
        nodes: [
            { kind: "text", text: "see" },
            ...resources.map((ref, index) => ({
                kind: "file" as const,
                entityId: `entity-${index}`,
                resourceId: ref.resourceId,
                fileOrigin: "pasted_text" as const,
                displayName: "pasted.txt",
            })),
        ],
        resources,
    }
}

describe("adoptDraftDocument", () => {
    it("rebinds every draft reference to the task and keeps the nodes", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: task } = await storeAt(TASK_OWNER)
        const first = await staged(draft, "first")
        const second = await staged(draft, "second")
        const document = documentWith([referenceOf(first), referenceOf(second)])

        const result = await adoptDraftDocument(document, task, () => draft)

        if (!result.ok) throw new Error(result.failure.message)
        const rebound = result.value.document
        expect(rebound.nodes).toEqual(document.nodes)
        expect(rebound.resources.map((ref) => ref.resourceId)).toEqual([first.resourceId, second.resourceId])
        expect(rebound.resources.every((ref) => ref.owner.kind === "task" && ref.generation === 2)).toBe(true)
        for (const ref of rebound.resources) expect((await task.resolve(ref)).ok).toBe(true)
    })

    it("removes the draft copies only when released", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: task } = await storeAt(TASK_OWNER)
        const record = await staged(draft, "release me")
        const result = await adoptDraftDocument(documentWith([referenceOf(record)]), task, () => draft)
        if (!result.ok) throw new Error(result.failure.message)

        expect((await draft.resolve(referenceOf(record))).ok).toBe(true)
        await result.value.release()

        expect((await draft.resolve(referenceOf(record))).ok).toBe(false)
        expect((await task.resolve(result.value.document.resources[0])).ok).toBe(true)
    })

    it("returns a document without draft references unchanged", async () => {
        const { store: task } = await storeAt(TASK_OWNER)
        const owned = await staged(task, "already the task's")
        const document = documentWith([referenceOf(owned)])
        const openDraft = vi.fn()

        const result = await adoptDraftDocument(document, task, openDraft)

        expect(result.ok ? result.value.document : undefined).toBe(document)
        expect(openDraft).not.toHaveBeenCalled()
    })

    it("rebinds a resource the document references twice", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: task } = await storeAt(TASK_OWNER)
        const record = await staged(draft, "referenced twice")

        const result = await adoptDraftDocument(documentWith([referenceOf(record), referenceOf(record)]), task, () => draft)

        expect(result.ok ? result.value.document.resources.map((ref) => ref.owner.kind) : []).toEqual(["task", "task"])
    })

    it("refuses a document that references several drafts", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: other } = await storeAt({ kind: "draft", draftId: "other-draft" })
        const { store: task, directory: taskDirectory } = await storeAt(TASK_OWNER)
        const own = await staged(draft, "own")
        const foreign = await staged(other, "foreign")

        const result = await adoptDraftDocument(documentWith([referenceOf(own), referenceOf(foreign)]), task, () => draft)

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_invalid")
        expect(await fs.readdir(taskDirectory)).toEqual([])
    })

    it("adopts nothing and keeps the draft when a resource changed after staging", async () => {
        const { store: draft, directory: draftDirectory } = await storeAt(DRAFT_OWNER)
        const { store: task, directory: taskDirectory } = await storeAt(TASK_OWNER)
        const intact = await staged(draft, "intact")
        const tampered = await staged(draft, "will change")
        await fs.writeFile(path.join(draftDirectory, tampered.resourceId, tampered.fileName), "changed")

        const result = await adoptDraftDocument(documentWith([referenceOf(intact), referenceOf(tampered)]), task, () => draft)

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_changed")
        expect(await fs.readdir(taskDirectory)).toEqual([])
        expect((await draft.resolve(referenceOf(intact))).ok).toBe(true)
    })
})

describe("verifyDraftDocument", () => {
    it("accepts a document whose draft resources are all intact, and leaves them in the draft", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const record = await staged(draft, "still staged")

        const result = await verifyDraftDocument(documentWith([referenceOf(record)]), () => draft)

        expect(result.ok).toBe(true)
        expect((await draft.resolve(referenceOf(record))).ok).toBe(true)
    })

    it("accepts a document without draft references without opening a draft", async () => {
        const openDraft = vi.fn()

        expect((await verifyDraftDocument(documentWith([]), openDraft)).ok).toBe(true)
        expect(openDraft).not.toHaveBeenCalled()
    })

    it("refuses a resource that changed or vanished after staging", async () => {
        const { store: draft, directory } = await storeAt(DRAFT_OWNER)
        const changed = await staged(draft, "will change")
        const vanished = await staged(draft, "will vanish")
        await fs.writeFile(path.join(directory, changed.resourceId, changed.fileName), "changed")
        await fs.rm(path.join(directory, vanished.resourceId), { recursive: true, force: true })

        const onChanged = await verifyDraftDocument(documentWith([referenceOf(changed)]), () => draft)
        const onVanished = await verifyDraftDocument(documentWith([referenceOf(vanished)]), () => draft)

        expect(onChanged.ok ? undefined : onChanged.failure.code).toBe("semantic_input_resource_changed")
        expect(onVanished.ok ? undefined : onVanished.failure.resourceId).toBe(vanished.resourceId)
    })

    it("refuses a document spanning several drafts or naming an invalid one", async () => {
        const { store: draft } = await storeAt(DRAFT_OWNER)
        const { store: other } = await storeAt({ kind: "draft", draftId: "other-draft" })
        const own = await staged(draft, "own")
        const foreign = await staged(other, "foreign")

        const spanning = await verifyDraftDocument(documentWith([referenceOf(own), referenceOf(foreign)]), () => draft)
        const invalid = await verifyDraftDocument(documentWith([referenceOf(own)]), () => {
            throw new Error("Invalid draft identity for input resources")
        })

        expect(spanning.ok ? undefined : spanning.failure.code).toBe("semantic_input_resource_invalid")
        expect(invalid.ok ? undefined : invalid.failure.code).toBe("semantic_input_resource_invalid")
    })
})
