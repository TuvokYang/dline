import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { MAX_ATTACHED_BASE64_TEXT_BYTES } from "@shared/attachments"
import type { InputResourceStageResults, StagedInputResource } from "@shared/proto/dline/file"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."

const openFile = vi.fn()
const showOpenDialogue = vi.fn()

vi.mock("@integrations/misc/open-file", () => ({ openFile: (...args: unknown[]) => openFile(...args) }))
vi.mock("@/hosts/host-provider", () => ({
    HostProvider: { window: { showOpenDialogue: (...args: unknown[]) => showOpenDialogue(...args), showMessage: vi.fn() } },
}))

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
)
const DRAFT_ID = randomUUID()
const previousDocumentsDir = process.env.DLINE_DOCS_DIR
let documentsDir: string
let sourceDir: string

beforeAll(() => {
    documentsDir = mkdtempSync(path.join(tmpdir(), "dline-input-resource-rpc-"))
    sourceDir = mkdtempSync(path.join(tmpdir(), "dline-input-resource-sources-"))
    process.env.DLINE_DOCS_DIR = documentsDir
})

afterAll(async () => {
    const { openDraftInputResources } = await import("@core/input-semantics/DraftInputResourceStore")
    const drafts = openDraftInputResources(DRAFT_ID)
    for (const resourceId of stagedDraftResources) await drafts.remove(resourceId)
    if (previousDocumentsDir === undefined) delete process.env.DLINE_DOCS_DIR
    else process.env.DLINE_DOCS_DIR = previousDocumentsDir
    await fs.rm(documentsDir, { recursive: true, force: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
})

beforeEach(() => {
    openFile.mockReset()
    showOpenDialogue.mockReset()
})

const stagedDraftResources: string[] = []

interface SessionOptions {
    readonly writable?: boolean
    readonly taskInstanceId?: string
}

function controllerWith(taskId?: string, { writable = true, taskInstanceId = "opening-1" }: SessionOptions = {}): Controller {
    return { task: taskId ? { taskId, writable, taskInstanceId } : undefined } as unknown as Controller
}

function stagedOf(results: InputResourceStageResults, index = 0): StagedInputResource {
    const staged = results.results[index]?.staged
    if (!staged) throw new Error(`expected a staged resource, got ${JSON.stringify(results.results[index])}`)
    if (staged.ref?.owner?.draftId) stagedDraftResources.push(staged.ref.resourceId)
    return staged
}

async function handlers() {
    const [
        { stageInputText },
        { stageInputBytes },
        { stageInputUris },
        { selectInputResources },
        { openInputResource },
        { removeInputResource },
        proto,
    ] = await Promise.all([
        import("../stageInputText"),
        import("../stageInputBytes"),
        import("../stageInputUris"),
        import("../selectInputResources"),
        import("../openInputResource"),
        import("../removeInputResource"),
        import("@shared/proto/dline/file"),
    ])
    return {
        stageInputText,
        stageInputBytes,
        stageInputUris,
        selectInputResources,
        openInputResource,
        removeInputResource,
        proto,
    }
}

describe("typed input resource staging", () => {
    it("lets the Host choose the active task as owner even when the request names a draft", async () => {
        const { stageInputText, proto } = await handlers()

        const staged = stagedOf(
            await stageInputText(
                controllerWith("task-rpc-1"),
                proto.StageInputTextRequest.create({ draftId: DRAFT_ID, text: "a\nb" }),
            ),
        )

        expect(staged.ref?.owner).toEqual({ taskId: "task-rpc-1" })
        expect(staged.ref?.generation).toBe(1)
        expect(staged.kind).toBe(proto.InputResourceKind.INPUT_RESOURCE_KIND_PASTED_TEXT)
        expect(staged.lineCount).toBe(2)
    })

    it("stages for the composer draft before any task exists", async () => {
        const { stageInputText, proto } = await handlers()

        const staged = stagedOf(
            await stageInputText(controllerWith(), proto.StageInputTextRequest.create({ draftId: DRAFT_ID, text: "x" })),
        )

        expect(staged.ref?.owner).toEqual({ draftId: DRAFT_ID })
    })

    it("rejects staging that names neither a task nor a draft", async () => {
        const { stageInputText, proto } = await handlers()

        const results = await stageInputText(controllerWith(), proto.StageInputTextRequest.create({ text: "x" }))

        expect(results.results[0]?.error?.code).toBe("semantic_input_resource_invalid")
    })

    it("accepts only a random draft identity, so one draft cannot guess another", async () => {
        const { stageInputText, proto } = await handlers()

        const results = await stageInputText(
            controllerWith(),
            proto.StageInputTextRequest.create({ draftId: "legacy-attachments", text: "x" }),
        )

        expect(results.results[0]?.error?.code).toBe("semantic_input_resource_invalid")
    })

    it("stages nothing into a task this window only shows read-only", async () => {
        const { stageInputText, proto } = await handlers()

        const results = await stageInputText(
            controllerWith("task-rpc-read-only", { writable: false }),
            proto.StageInputTextRequest.create({ draftId: DRAFT_ID, text: "x" }),
        )

        expect(results.results[0]?.error).toMatchObject({ code: "semantic_input_resource_invalid" })
        expect(results.results[0]?.error?.message).toContain("read-only")
        await expect(fs.access(path.join(documentsDir, "tasks", "task-rpc-read-only"))).rejects.toThrow()
    })

    it("reports one ordered result per file and attributes a rejection to its name", async () => {
        const { stageInputBytes, proto } = await handlers()

        const results = await stageInputBytes(
            controllerWith("task-rpc-2"),
            proto.StageInputBytesRequest.create({
                files: [
                    { fileName: "shot.png", data: PNG_1X1 },
                    // Opaque binary whose base64 text exceeds the per-attachment budget.
                    { fileName: "huge.bin", data: Buffer.alloc(Math.floor(MAX_ATTACHED_BASE64_TEXT_BYTES / 4) * 3 + 1) },
                ],
            }),
        )

        expect(stagedOf(results, 0).kind).toBe(proto.InputResourceKind.INPUT_RESOURCE_KIND_IMAGE)
        expect(results.results[1]?.error).toMatchObject({ code: "semantic_input_resource_too_large", displayName: "huge.bin" })
    })

    it("returns only the sanitized leaf of a requested name in an error", async () => {
        const { stageInputBytes, proto } = await handlers()

        const results = await stageInputBytes(
            controllerWith("task-rpc-names"),
            proto.StageInputBytesRequest.create({
                files: [
                    {
                        fileName: "C:\\Users\\me\\private\\huge\u0007.bin",
                        data: Buffer.alloc(Math.floor(MAX_ATTACHED_BASE64_TEXT_BYTES / 4) * 3 + 1),
                    },
                ],
            }),
        )

        expect(results.results[0]?.error?.displayName).toBe("huge.bin")
    })

    it("links a dropped local file and refuses a non-file URI", async () => {
        const { stageInputUris, proto } = await handlers()
        const source = path.join(sourceDir, "notes.md")
        await fs.writeFile(source, "# notes\n")

        const results = await stageInputUris(
            controllerWith("task-rpc-3"),
            proto.StageInputUrisRequest.create({ uris: [pathToFileURL(source).href, "https://example.com/x"] }),
        )

        expect(stagedOf(results, 0).displayName).toBe("notes.md")
        expect(results.results[1]?.error?.code).toBe("semantic_input_resource_invalid")
    })

    it("rejects an image picked while the model cannot read images", async () => {
        const { selectInputResources, proto } = await handlers()
        const image = path.join(sourceDir, "picked.png")
        const text = path.join(sourceDir, "picked.txt")
        await fs.writeFile(image, PNG_1X1)
        await fs.writeFile(text, "plain")
        showOpenDialogue.mockResolvedValue({ paths: [image, text] })

        const results = await selectInputResources(
            controllerWith("task-rpc-4"),
            proto.SelectInputResourcesRequest.create({ imagesAllowed: false }),
        )

        expect(results.results[0]?.error).toMatchObject({
            code: "semantic_input_resource_invalid_mime",
            displayName: "picked.png",
        })
        expect(stagedOf(results, 1).displayName).toBe("picked.txt")
    })

    it("links only as many picked files as fit in the draft", async () => {
        const { selectInputResources, proto } = await handlers()
        const picked = ["a.txt", "b.txt", "c.txt"].map((name) => path.join(sourceDir, `fit-${name}`))
        await Promise.all(picked.map((file) => fs.writeFile(file, "picked")))
        showOpenDialogue.mockResolvedValue({ paths: picked })

        const results = await selectInputResources(
            controllerWith("task-rpc-picker-fit"),
            proto.SelectInputResourcesRequest.create({ imagesAllowed: true, maxCount: 2 }),
        )

        expect(showOpenDialogue).toHaveBeenCalledWith(expect.objectContaining({ canSelectMany: true }))
        expect(results.results.map((result) => result.staged?.displayName)).toEqual(["fit-a.txt", "fit-b.txt"])
    })

    it("offers a single pick for one free slot and no dialog for none", async () => {
        const { selectInputResources, proto } = await handlers()
        showOpenDialogue.mockResolvedValue({ paths: [] })

        await selectInputResources(
            controllerWith("task-rpc-picker-one"),
            proto.SelectInputResourcesRequest.create({ imagesAllowed: true, maxCount: 1 }),
        )
        expect(showOpenDialogue).toHaveBeenLastCalledWith(expect.objectContaining({ canSelectMany: false }))

        showOpenDialogue.mockClear()
        const none = await selectInputResources(
            controllerWith("task-rpc-picker-none"),
            proto.SelectInputResourcesRequest.create({ imagesAllowed: true, maxCount: 0 }),
        )
        expect(showOpenDialogue).not.toHaveBeenCalled()
        expect(none.results).toEqual([])
    })

    it("does not open the picker when nothing could own the selection", async () => {
        const { selectInputResources, proto } = await handlers()

        const results = await selectInputResources(
            controllerWith("task-rpc-picker-read-only", { writable: false }),
            proto.SelectInputResourcesRequest.create({ imagesAllowed: true }),
        )

        expect(showOpenDialogue).not.toHaveBeenCalled()
        expect(results.results[0]?.error?.code).toBe("semantic_input_resource_invalid")
    })

    it("stages nothing when the active task changed while the picker was open", async () => {
        const { selectInputResources, proto } = await handlers()
        const picked = path.join(sourceDir, "picked-during-switch.txt")
        await fs.writeFile(picked, "chosen for the first task")
        const controller = controllerWith("task-rpc-picker-a")
        showOpenDialogue.mockImplementation(async () => {
            ;(controller as unknown as { task: unknown }).task = {
                taskId: "task-rpc-picker-b",
                writable: true,
                taskInstanceId: "opening-2",
            }
            return { paths: [picked] }
        })

        const results = await selectInputResources(controller, proto.SelectInputResourcesRequest.create({ imagesAllowed: true }))

        expect(results.results[0]?.error).toMatchObject({ code: "semantic_input_resource_invalid" })
        await expect(fs.access(path.join(documentsDir, "tasks", "task-rpc-picker-a"))).rejects.toThrow()
        await expect(fs.access(path.join(documentsDir, "tasks", "task-rpc-picker-b"))).rejects.toThrow()
    })

    it("never returns a local path to the Webview", async () => {
        const { stageInputText, stageInputUris, proto } = await handlers()
        const source = path.join(sourceDir, "secret.txt")
        await fs.writeFile(source, "secret")

        const staged = await stageInputText(
            controllerWith("task-rpc-5"),
            proto.StageInputTextRequest.create({ text: "payload text" }),
        )
        const linked = await stageInputUris(
            controllerWith("task-rpc-5"),
            proto.StageInputUrisRequest.create({ uris: [pathToFileURL(source).href] }),
        )

        const serialized = JSON.stringify([staged, linked])
        expect(serialized).not.toContain(documentsDir.replace(/\\/g, "\\\\"))
        expect(serialized).not.toContain(sourceDir.replace(/\\/g, "\\\\"))
        expect(serialized).not.toContain("payload text")
    })
})

describe("typed input resource access", () => {
    it("opens the verified local copy of the active task's resource", async () => {
        const { stageInputText, openInputResource, proto } = await handlers()
        const staged = stagedOf(
            await stageInputText(controllerWith("task-rpc-6"), proto.StageInputTextRequest.create({ text: "open me" })),
        )

        const result = await openInputResource(
            controllerWith("task-rpc-6"),
            proto.InputResourceRequest.create({ ref: staged.ref }),
        )

        expect(result.error).toBeUndefined()
        expect(openFile).toHaveBeenCalledTimes(1)
        expect(String(openFile.mock.calls[0]?.[0])).toContain(path.join("tasks", "task-rpc-6", "tmp", "input-resources"))
    })

    it("refuses to open another task's resource", async () => {
        const { stageInputText, openInputResource, proto } = await handlers()
        const staged = stagedOf(
            await stageInputText(controllerWith("task-rpc-7"), proto.StageInputTextRequest.create({ text: "other" })),
        )

        const result = await openInputResource(
            controllerWith("task-rpc-8"),
            proto.InputResourceRequest.create({ ref: staged.ref }),
        )

        expect(result.error?.code).toBe("semantic_input_resource_invalid")
        expect(openFile).not.toHaveBeenCalled()
    })

    it("fails closed when the stored copy changed after staging", async () => {
        const { stageInputText, openInputResource, proto } = await handlers()
        const staged = stagedOf(
            await stageInputText(controllerWith("task-rpc-9"), proto.StageInputTextRequest.create({ text: "frozen" })),
        )
        const resourceDirectory = path.join(
            documentsDir,
            "tasks",
            "task-rpc-9",
            "tmp",
            "input-resources",
            staged.ref?.resourceId ?? "",
        )
        const contentFile = (await fs.readdir(resourceDirectory)).find((name) => name !== "input-resource.json") ?? ""
        await fs.writeFile(path.join(resourceDirectory, contentFile), "edited")

        const result = await openInputResource(
            controllerWith("task-rpc-9"),
            proto.InputResourceRequest.create({ ref: staged.ref }),
        )

        expect(result.error?.code).toBe("semantic_input_resource_changed")
        expect(openFile).not.toHaveBeenCalled()
    })

    it("reports an editor that cannot open the copy without leaking its path", async () => {
        const { stageInputText, openInputResource, proto } = await handlers()
        const staged = stagedOf(
            await stageInputText(controllerWith("task-rpc-open-fails"), proto.StageInputTextRequest.create({ text: "x" })),
        )
        openFile.mockRejectedValue(Object.assign(new Error(`cannot open ${documentsDir}`), { code: "EACCES" }))

        const result = await openInputResource(
            controllerWith("task-rpc-open-fails"),
            proto.InputResourceRequest.create({ ref: staged.ref }),
        )

        expect(result.error).toMatchObject({ code: "semantic_input_resource_open_failed", resourceId: staged.ref?.resourceId })
        expect(result.error?.message).toContain("EACCES")
        expect(result.error?.message).not.toContain(documentsDir)
    })

    it("removes a draft resource only for the draft that owns it", async () => {
        const { stageInputText, removeInputResource, openInputResource, proto } = await handlers()
        const staged = stagedOf(
            await stageInputText(controllerWith(), proto.StageInputTextRequest.create({ draftId: DRAFT_ID, text: "drop me" })),
        )

        const foreign = await removeInputResource(
            controllerWith(),
            proto.InputResourceRequest.create({ draftId: randomUUID(), ref: staged.ref }),
        )
        const own = await removeInputResource(
            controllerWith(),
            proto.InputResourceRequest.create({ draftId: DRAFT_ID, ref: staged.ref }),
        )
        const reopened = await openInputResource(
            controllerWith(),
            proto.InputResourceRequest.create({ draftId: DRAFT_ID, ref: staged.ref }),
        )

        expect(foreign.error?.code).toBe("semantic_input_resource_invalid")
        expect(own.error).toBeUndefined()
        expect(reopened.error?.code).toBe("semantic_input_resource_missing")
    })

    it("keeps task resources out of composer removal", async () => {
        const { stageInputText, removeInputResource, proto } = await handlers()
        const staged = stagedOf(
            await stageInputText(controllerWith("task-rpc-10"), proto.StageInputTextRequest.create({ text: "kept" })),
        )

        const result = await removeInputResource(
            controllerWith("task-rpc-10"),
            proto.InputResourceRequest.create({ ref: staged.ref }),
        )

        expect(result.error?.code).toBe("semantic_input_resource_invalid")
    })

    it("rejects a reference that names no owner", async () => {
        const { openInputResource, proto } = await handlers()

        const result = await openInputResource(
            controllerWith("task-rpc-11"),
            proto.InputResourceRequest.create({ ref: { resourceId: "00000000-0000-4000-8000-000000000000", generation: 1 } }),
        )

        expect(result.error?.code).toBe("semantic_input_resource_invalid")
    })
})
