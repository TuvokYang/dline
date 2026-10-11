import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_ATTACHED_TEXT_FILE_BYTES } from "@shared/attachments"
import type { InputResourceOwner, SemanticResourceRef } from "@shared/input-semantics/document"
import { INLINE_TEXT_MAX_BYTES, INLINE_TEXT_MAX_LINES } from "@shared/input-semantics/resource-policy"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
    INPUT_RESOURCE_RECORD_FILE,
    type InputResourceRecord,
    type InputResourceRoot,
    InputResourceStore,
    inputResourceDisplayName,
    referenceOf,
} from "../InputResourceStore"

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
)
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])
const DRAFT_OWNER: InputResourceOwner = { kind: "draft", draftId: "draft-a" }
const TASK_OWNER: InputResourceOwner = { kind: "task", taskId: "task-a" }

let workspace: string

beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "dline-input-resource-store-"))
})

afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
})

async function openStore(
    owner: InputResourceOwner = DRAFT_OWNER,
    onVerifiedAccess?: (resourceId: string) => Promise<void>,
): Promise<{ store: InputResourceStore; directory: string }> {
    const directory = await fs.mkdtemp(path.join(workspace, "root-"))
    const root: InputResourceRoot = {
        owner,
        resourceDirectory: (resourceId) => path.join(directory, resourceId),
        ...(onVerifiedAccess ? { onVerifiedAccess } : {}),
    }
    return { store: new InputResourceStore(root), directory }
}

function sha256(bytes: string | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}

function expectStaged<T>(result: { ok: true; value: T } | { ok: false; failure: unknown }): T {
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
    return result.value
}

function pngWithSize(width: number, height: number): Buffer {
    const png = Buffer.from(PNG_1X1)
    png.writeUInt32BE(width, 16)
    png.writeUInt32BE(height, 20)
    return png
}

async function recordFileOf(directory: string, record: InputResourceRecord): Promise<string> {
    return path.join(directory, record.resourceId, INPUT_RESOURCE_RECORD_FILE)
}

describe("InputResourceStore staging", () => {
    it("stages pasted text once and freezes its identity by hash", async () => {
        const { store, directory } = await openStore()
        const text = "第一行\r\nsecond\nthird"

        const record = expectStaged(await store.stageText(text))

        expect(record.resourceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(record.owner).toEqual(DRAFT_OWNER)
        expect(record.generation).toBe(1)
        expect(record.kind).toBe("pasted_text")
        expect(record.mediaType).toBe("text/plain")
        expect(record.lineCount).toBe(3)
        expect(record.byteLength).toBe(Buffer.byteLength(text, "utf8"))
        expect(record.contentHash).toBe(sha256(Buffer.from(text, "utf8")))
        expect(record.displayName).toMatch(/^input_\d{14}_[0-9a-f]{8}\.txt$/)

        const resolved = expectStaged(await store.resolve(referenceOf(record)))
        expect(path.dirname(resolved.contentPath)).toBe(path.join(directory, record.resourceId))
        const loaded = expectStaged(await store.readBytes(referenceOf(record)))
        expect(loaded.bytes.toString("utf8")).toBe(text)
    })

    it("reports the same line and byte measures the inline budget uses at its boundary", async () => {
        const { store } = await openStore()
        const atLineBudget = Array.from({ length: INLINE_TEXT_MAX_LINES }, (_, index) => `line ${index}`).join("\n")
        const atByteBudget = "a".repeat(INLINE_TEXT_MAX_BYTES)

        expect(expectStaged(await store.stageText(atLineBudget)).lineCount).toBe(INLINE_TEXT_MAX_LINES)
        expect(expectStaged(await store.stageText(atByteBudget)).byteLength).toBe(INLINE_TEXT_MAX_BYTES)
    })

    it("keeps a requested text extension and rejects an unsafe one", async () => {
        const { store } = await openStore()

        expect(expectStaged(await store.stageText("{}", { extension: "json" })).displayName).toMatch(/\.json$/)
        expect(expectStaged(await store.stageText("x", { extension: "../evil" })).displayName).toMatch(/\.txt$/)
    })

    it("derives an image media type from its bytes, not its name", async () => {
        const { store } = await openStore()

        const record = expectStaged(await store.stageBytes("screenshot.png", PNG_1X1))

        expect(record.kind).toBe("image")
        expect(record.mediaType).toBe("image/png")
        expect(record.displayName).toBe("screenshot.png")
        expect(record.lineCount).toBeUndefined()
    })

    it("rejects an image name whose bytes are not an attachable image", async () => {
        const { store } = await openStore()

        const forged = await store.stageBytes("photo.png", Buffer.from("not an image at all"))
        const gif = await store.stageBytes("animation.png", GIF_HEADER)

        expect(forged.ok ? undefined : forged.failure.code).toBe("semantic_input_resource_invalid_mime")
        expect(gif.ok ? undefined : gif.failure.code).toBe("semantic_input_resource_invalid_mime")
    })

    it("rejects an image beyond the dimension providers accept", async () => {
        const { store } = await openStore()

        const result = await store.stageBytes("huge.png", pngWithSize(8000, 10))

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_too_large")
    })

    it("requires a document's bytes to match its declared format", async () => {
        const { store } = await openStore()

        const pdf = expectStaged(await store.stageBytes("report.pdf", Buffer.from("%PDF-1.7\n%binary")))
        const fakePdf = await store.stageBytes("report.pdf", Buffer.from("plain text"))
        const fakeDocx = await store.stageBytes("notes.docx", Buffer.from("plain text"))

        expect(pdf.kind).toBe("file")
        expect(pdf.mediaType).toBe("application/pdf")
        expect(fakePdf.ok ? undefined : fakePdf.failure.code).toBe("semantic_input_resource_invalid_mime")
        expect(fakeDocx.ok ? undefined : fakeDocx.failure.code).toBe("semantic_input_resource_invalid_mime")
    })

    it("reads text files as text and rejects binary content under a text name", async () => {
        const { store } = await openStore()

        const json = expectStaged(await store.stageBytes("data.json", Buffer.from('{\n  "a": 1\n}')))
        const binary = await store.stageBytes("notes.txt", Buffer.from([0, 159, 146, 150, 0, 0, 1, 2]))

        expect(json.mediaType).toBe("application/json")
        expect(json.lineCount).toBe(3)
        expect(binary.ok ? undefined : binary.failure.code).toBe("semantic_input_resource_invalid_mime")
    })

    it("rejects content above the attachment size limit before writing it", async () => {
        const { store, directory } = await openStore()

        const result = await store.stageBytes("big.txt", Buffer.alloc(MAX_ATTACHED_TEXT_FILE_BYTES + 1, 0x61))

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_too_large")
        expect(await fs.readdir(directory)).toEqual([])
    })

    it("copies a picked file so later edits of the source do not change the staged input", async () => {
        const { store } = await openStore()
        const source = path.join(workspace, "picked.md")
        await fs.writeFile(source, "# original\n")

        const record = expectStaged(await store.stageFile(source))
        await fs.writeFile(source, "# edited afterwards\n")

        expect(record.displayName).toBe("picked.md")
        expect(record.mediaType).toBe("text/markdown")
        expect(expectStaged(await store.readBytes(referenceOf(record))).bytes.toString("utf8")).toBe("# original\n")
    })

    it("reports a missing or non-file source without leaking its path", async () => {
        const { store } = await openStore()

        const missing = await store.stageFile(path.join(workspace, "absent", "secret-name.txt"))
        const directory = await store.stageFile(workspace)

        expect(missing.ok ? undefined : missing.failure.code).toBe("semantic_input_resource_missing")
        expect(directory.ok ? undefined : directory.failure.code).toBe("semantic_input_resource_invalid")
        expect(missing.ok ? "" : missing.failure.message).not.toContain(workspace)
    })

    it("keeps a content file apart from the record even when the name collides", async () => {
        const { store, directory } = await openStore()

        const record = expectStaged(await store.stageBytes(INPUT_RESOURCE_RECORD_FILE, Buffer.from("{}")))

        expect(record.displayName).toBe(INPUT_RESOURCE_RECORD_FILE)
        expect(record.fileName).not.toBe(INPUT_RESOURCE_RECORD_FILE)
        expect((await fs.readdir(path.join(directory, record.resourceId))).sort()).toEqual(
            [INPUT_RESOURCE_RECORD_FILE, record.fileName].sort(),
        )
        expect(expectStaged(await store.readBytes(referenceOf(record))).bytes.toString("utf8")).toBe("{}")
    })
})

describe("InputResourceStore resolution fails closed", () => {
    async function stagedText(owner: InputResourceOwner = DRAFT_OWNER) {
        const opened = await openStore(owner)
        const record = expectStaged(await opened.store.stageText("frozen payload"))
        return { ...opened, record, ref: referenceOf(record) }
    }

    async function failureCodeOf(store: InputResourceStore, ref: SemanticResourceRef): Promise<string | undefined> {
        const result = await store.resolve(ref)
        return result.ok ? undefined : result.failure.code
    }

    it("rejects a resource id that is not a store-issued identity", async () => {
        const { store, ref } = await stagedText()

        expect(await failureCodeOf(store, { ...ref, resourceId: "../escape" })).toBe("semantic_input_resource_invalid")
    })

    it("rejects a reference that claims another owner", async () => {
        const { store, ref } = await stagedText()

        expect(await failureCodeOf(store, { ...ref, owner: { kind: "draft", draftId: "draft-b" } })).toBe(
            "semantic_input_resource_invalid",
        )
        expect(await failureCodeOf(store, { ...ref, owner: TASK_OWNER })).toBe("semantic_input_resource_invalid")
    })

    it("reports a reference to an unknown resource as missing", async () => {
        const { store, ref } = await stagedText()

        expect(await failureCodeOf(store, { ...ref, resourceId: "00000000-0000-4000-8000-000000000000" })).toBe(
            "semantic_input_resource_missing",
        )
    })

    it("rejects forged generation, size and media type claims", async () => {
        const { store, ref } = await stagedText()

        expect(await failureCodeOf(store, { ...ref, generation: 2 })).toBe("semantic_input_resource_invalid")
        expect(await failureCodeOf(store, { ...ref, byteLength: ref.byteLength + 1 })).toBe("semantic_input_resource_invalid")
        expect(await failureCodeOf(store, { ...ref, mediaType: "image/png" })).toBe("semantic_input_resource_invalid_mime")
    })

    it("rejects a reference whose frozen hash differs from the record", async () => {
        const { store, ref } = await stagedText()

        expect(await failureCodeOf(store, { ...ref, expectedContentHash: "0".repeat(64) })).toBe(
            "semantic_input_resource_changed",
        )
    })

    it("detects content changed on disk after staging", async () => {
        const { store, directory, record, ref } = await stagedText()
        await fs.writeFile(path.join(directory, record.resourceId, record.fileName), "tampered payload")

        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_changed")
        const loaded = await store.readBytes(ref)
        expect(loaded.ok ? undefined : loaded.failure.code).toBe("semantic_input_resource_changed")
    })

    it("rejects a record whose content name escapes its resource directory", async () => {
        const { store, directory, record, ref } = await stagedText()
        const recordFile = await recordFileOf(directory, record)
        const stored = JSON.parse(await fs.readFile(recordFile, "utf8"))
        await fs.writeFile(recordFile, JSON.stringify({ ...stored, fileName: "../outside.txt" }))

        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_invalid")
    })

    it("rejects a record that names a different resource or owner than its location", async () => {
        const { store, directory, record, ref } = await stagedText()
        const recordFile = await recordFileOf(directory, record)
        const stored = JSON.parse(await fs.readFile(recordFile, "utf8"))

        await fs.writeFile(recordFile, JSON.stringify({ ...stored, owner: { kind: "draft", draftId: "draft-b" } }))
        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_invalid")

        await fs.writeFile(recordFile, JSON.stringify({ ...stored, resourceId: "00000000-0000-4000-8000-000000000000" }))
        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_invalid")

        await fs.writeFile(recordFile, "{ not json")
        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_invalid")
    })

    it("never falls back to a backup when the committed record is invalid", async () => {
        const { store, directory, record, ref } = await stagedText()
        const recordFile = await recordFileOf(directory, record)
        await fs.copyFile(recordFile, `${recordFile}.bak`)
        await fs.writeFile(recordFile, "{ not json")

        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_invalid")
    })

    it("fails closed instead of throwing when the root cannot address an identity", async () => {
        const store = new InputResourceStore({
            owner: DRAFT_OWNER,
            resourceDirectory: () => {
                throw new Error("unaddressable")
            },
        })

        const staged = await store.stageText("cannot land")
        const resolved = await store.resolve({
            resourceId: "00000000-0000-4000-8000-000000000000",
            expectedContentHash: "0".repeat(64),
            mediaType: "text/plain",
            byteLength: 1,
            owner: DRAFT_OWNER,
            generation: 1,
        })

        expect(staged.ok ? undefined : staged.failure.code).toBe("semantic_input_resource_invalid")
        expect(resolved.ok ? undefined : resolved.failure.code).toBe("semantic_input_resource_invalid")
    })

    it("rejects a resource directory redirected outside its root", async () => {
        const { store, directory, record, ref } = await stagedText()
        const resourceDirectory = path.join(directory, record.resourceId)
        const outside = path.join(workspace, `outside-${record.resourceId}`)
        await fs.cp(resourceDirectory, outside, { recursive: true })
        await fs.rm(resourceDirectory, { recursive: true, force: true })
        await fs.symlink(outside, resourceDirectory, "junction")

        expect(await failureCodeOf(store, ref)).toBe("semantic_input_resource_invalid")
    })

    it("never puts resource content or local paths into a failure message", async () => {
        const { store, directory, record, ref } = await stagedText()
        await fs.writeFile(path.join(directory, record.resourceId, record.fileName), "tampered payload")

        const result = await store.resolve(ref)

        expect(result.ok).toBe(false)
        const message = result.ok ? "" : result.failure.message
        expect(message).not.toContain("payload")
        expect(message).not.toContain(directory)
        expect(result.ok ? undefined : result.failure.resourceId).toBe(record.resourceId)
    })
})

describe("InputResourceStore lifecycle", () => {
    it("publishes a resource only complete and leaves no staging directory behind", async () => {
        const { store, directory } = await openStore()

        const record = expectStaged(await store.stageText("published whole"))

        expect(await fs.readdir(directory)).toEqual([record.resourceId])
        expect((await fs.readdir(path.join(directory, record.resourceId))).sort()).toEqual(
            [INPUT_RESOURCE_RECORD_FILE, record.fileName].sort(),
        )
    })

    it.skipIf(process.platform === "win32")("keeps resource files readable only by their owner", async () => {
        const { store, directory } = await openStore()
        const record = expectStaged(await store.stageText("private source"))
        const resourceDirectory = path.join(directory, record.resourceId)

        expect((await fs.stat(resourceDirectory)).mode & 0o777).toBe(0o700)
        expect((await fs.stat(path.join(resourceDirectory, record.fileName))).mode & 0o777).toBe(0o600)
        expect((await fs.stat(path.join(resourceDirectory, INPUT_RESOURCE_RECORD_FILE))).mode & 0o777).toBe(0o600)
    })

    it("removes its own resource and treats an absent one as already removed", async () => {
        const { store, directory } = await openStore()
        const record = expectStaged(await store.stageText("to remove"))

        expect(expectStaged(await store.remove(record.resourceId)).removed).toBe(true)
        expect(await fs.readdir(directory)).toEqual([])
        expect(expectStaged(await store.remove(record.resourceId)).removed).toBe(false)
    })

    it("refuses to remove a resource directory redirected outside its root", async () => {
        const { store, directory } = await openStore()
        const record = expectStaged(await store.stageText("redirected"))
        const resourceDirectory = path.join(directory, record.resourceId)
        const outside = path.join(workspace, `outside-remove-${record.resourceId}`)
        await fs.cp(resourceDirectory, outside, { recursive: true })
        await fs.rm(resourceDirectory, { recursive: true, force: true })
        await fs.symlink(outside, resourceDirectory, "junction")

        const removal = await store.remove(record.resourceId)

        expect(removal.ok ? undefined : removal.failure.code).toBe("semantic_input_resource_invalid")
        expect((await fs.readdir(outside)).length).toBe(2)
    })

    it("refuses to remove a resource another owner holds in a shared root", async () => {
        const directory = await fs.mkdtemp(path.join(workspace, "shared-"))
        const rootFor = (owner: InputResourceOwner): InputResourceRoot => ({
            owner,
            resourceDirectory: (resourceId) => path.join(directory, resourceId),
        })
        const owning = new InputResourceStore(rootFor(DRAFT_OWNER))
        const other = new InputResourceStore(rootFor({ kind: "draft", draftId: "draft-b" }))
        const record = expectStaged(await owning.stageText("kept"))

        const removal = await other.remove(record.resourceId)

        expect(removal.ok ? undefined : removal.failure.code).toBe("semantic_input_resource_invalid")
        expect((await owning.resolve(referenceOf(record))).ok).toBe(true)
    })

    it("tells the root about every verified access and about nothing else", async () => {
        const onVerifiedAccess = vi.fn(async (_resourceId: string) => undefined)
        const { store } = await openStore(DRAFT_OWNER, onVerifiedAccess)
        const record = expectStaged(await store.stageText("still referenced"))

        expect((await store.resolve(referenceOf(record))).ok).toBe(true)
        expect((await store.resolve({ ...referenceOf(record), expectedContentHash: "0".repeat(64) })).ok).toBe(false)

        expect(onVerifiedAccess.mock.calls).toEqual([[record.resourceId]])
    })

    it("still returns a verified resource when the root cannot keep it alive", async () => {
        const { store } = await openStore(DRAFT_OWNER, async () => {
            throw new Error("retention unavailable")
        })
        const record = expectStaged(await store.stageText("verified anyway"))

        expect((await store.resolve(referenceOf(record))).ok).toBe(true)
    })

    it("adopts a resource under the same identity with the new owner and a later generation", async () => {
        const { store: draft } = await openStore(DRAFT_OWNER)
        const { store: task } = await openStore(TASK_OWNER)
        const source = expectStaged(await draft.stageBytes("diagram.png", PNG_1X1))

        const adoption = expectStaged(await task.adoptFrom(draft, referenceOf(source)))

        expect(adoption.reused).toBe(false)
        expect(adoption.record).toMatchObject({
            resourceId: source.resourceId,
            owner: TASK_OWNER,
            generation: source.generation + 1,
            contentHash: source.contentHash,
            mediaType: "image/png",
            displayName: "diagram.png",
        })
        expect((await task.resolve(referenceOf(adoption.record))).ok).toBe(true)
        expect((await task.resolve(referenceOf(source))).ok).toBe(false)
        expect((await draft.resolve(referenceOf(source))).ok).toBe(true)
    })

    it("reuses an identical earlier adoption instead of failing a retried hand-off", async () => {
        const { store: draft } = await openStore(DRAFT_OWNER)
        const { store: task } = await openStore(TASK_OWNER)
        const source = expectStaged(await draft.stageText("handed over"))

        const first = expectStaged(await task.adoptFrom(draft, referenceOf(source)))
        const second = expectStaged(await task.adoptFrom(draft, referenceOf(source)))

        expect(second.reused).toBe(true)
        expect(second.record).toEqual(first.record)
    })

    it("does not adopt a source whose content changed after it was frozen", async () => {
        const { store: draft, directory } = await openStore(DRAFT_OWNER)
        const { store: task, directory: taskDirectory } = await openStore(TASK_OWNER)
        const source = expectStaged(await draft.stageText("original"))
        await fs.writeFile(path.join(directory, source.resourceId, source.fileName), "tampered")

        const adoption = await task.adoptFrom(draft, referenceOf(source))

        expect(adoption.ok ? undefined : adoption.failure.code).toBe("semantic_input_resource_changed")
        expect(await fs.readdir(taskDirectory)).toEqual([])
    })

    it("adopts despite a staging directory an interrupted adoption abandoned", async () => {
        const { store: draft } = await openStore(DRAFT_OWNER)
        const { store: task, directory: taskDirectory } = await openStore(TASK_OWNER)
        const source = expectStaged(await draft.stageText("retried"))
        await fs.mkdir(path.join(taskDirectory, `${source.resourceId}.abandoned.staging`))

        const adoption = await task.adoptFrom(draft, referenceOf(source))

        expect(adoption.ok).toBe(true)
    })

    it("serializes concurrent adoptions of one resource into the same owner", async () => {
        const { store: draft } = await openStore(DRAFT_OWNER)
        const { store: task } = await openStore(TASK_OWNER)
        const source = expectStaged(await draft.stageText("adopted twice at once"))

        const adoptions = await Promise.all([
            task.adoptFrom(draft, referenceOf(source)),
            task.adoptFrom(draft, referenceOf(source)),
        ])

        expect(adoptions.map((adoption) => (adoption.ok ? adoption.value.reused : undefined)).sort()).toEqual([false, true])
    })

    it("adopts all references or removes the copies it created", async () => {
        const { store: draft, directory } = await openStore(DRAFT_OWNER)
        const { store: task, directory: taskDirectory } = await openStore(TASK_OWNER)
        const earlier = expectStaged(await draft.stageText("adopted earlier"))
        const intact = expectStaged(await draft.stageText("intact"))
        const tampered = expectStaged(await draft.stageText("tampered later"))
        const earlierAdoption = expectStaged(await task.adoptFrom(draft, referenceOf(earlier)))
        await fs.writeFile(path.join(directory, tampered.resourceId, tampered.fileName), "changed")

        const result = await task.adoptAll(draft, [referenceOf(earlier), referenceOf(intact), referenceOf(tampered)])

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_changed")
        expect(await fs.readdir(taskDirectory)).toEqual([earlier.resourceId])
        expect((await task.resolve(referenceOf(earlierAdoption.record))).ok).toBe(true)
    })
})

describe("inputResourceDisplayName", () => {
    it("keeps the leaf of a name from any platform without control characters", () => {
        expect(inputResourceDisplayName("C:\\Users\\me\\notes.md")).toBe("notes.md")
        expect(inputResourceDisplayName("/home/me/report\u0007.pdf")).toBe("report.pdf")
        expect(inputResourceDisplayName("\u0000\u001f")).toBe("attachment")
    })
})
