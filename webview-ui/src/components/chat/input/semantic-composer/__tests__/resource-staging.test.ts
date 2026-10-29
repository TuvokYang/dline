import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { InputResourceKind, InputResourceStageResults } from "@shared/proto/dline/file"
import { toProtoSemanticResourceRef } from "@shared/proto-conversions/input-semantics/document"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createReadyResourceAtom, failedResourceAtom } from "../atoms"
import { SemanticComposerEngine } from "../engine"
import { ATOM_PLACEHOLDER, flatTextOf, type ResourceAtom, resourceAtomsOf, stateFromText } from "../model"
import {
    releaseStaging,
    retryResource,
    stageFiles,
    stageLegacyAttachments,
    stagePastedText,
    stageSelectedResources,
    stageUris,
} from "../resource-staging"

const client = vi.hoisted(() => ({
    stageInputBytes: vi.fn(),
    stageInputUris: vi.fn(),
    stageInputText: vi.fn(),
    selectInputResources: vi.fn(),
    openInputResource: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: client }))

const DRAFT_ID = "draft-1"

function refOf(resourceId: string): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash: `sha256:${resourceId}`,
        mediaType: "text/plain",
        byteLength: 4,
        owner: { kind: "draft", draftId: DRAFT_ID },
        generation: 1,
    }
}

function staged(resourceId: string, displayName: string, kind = InputResourceKind.INPUT_RESOURCE_KIND_FILE, lineCount?: number) {
    return {
        staged: {
            ref: toProtoSemanticResourceRef(refOf(resourceId)),
            displayName,
            kind,
            ...(lineCount === undefined ? {} : { lineCount }),
        },
    }
}

function failure(code: string, displayName?: string) {
    return { error: { code, message: `${code} message`, ...(displayName ? { displayName } : {}) } }
}

function results(...items: ReturnType<typeof staged | typeof failure>[]): InputResourceStageResults {
    return InputResourceStageResults.create({ results: items })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

/** Let a retry the module started without awaiting run to its end. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const resources = (engine: SemanticComposerEngine): ResourceAtom[] => resourceAtomsOf(engine.getState().segments)

/** An engine whose draft already holds `count` ready attachments. */
function engineWithResources(count: number): SemanticComposerEngine {
    const engine = new SemanticComposerEngine()
    for (let index = 0; index < count; index++) {
        engine.apply({
            type: "insert_atom",
            atom: createReadyResourceAtom({
                ref: refOf(`res-held-${index}`),
                displayName: `held-${index}.md`,
                nodeKind: "file",
                fileOrigin: "uploaded_file",
            }),
        })
    }
    return engine
}

/** Replace the URL object hooks for one test body and restore them afterwards. */
async function withObjectUrls(body: (revoke: ReturnType<typeof vi.fn>) => Promise<void>): Promise<void> {
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    const revoke = vi.fn()
    let next = 0
    URL.createObjectURL = vi.fn(() => `blob:preview-${++next}`)
    URL.revokeObjectURL = revoke
    try {
        await body(revoke)
    } finally {
        URL.createObjectURL = original.create
        URL.revokeObjectURL = original.revoke
    }
}

const image = (name: string) => new File([new Uint8Array([1])], name, { type: "image/png" })

describe("resource staging", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, "warn").mockImplementation(() => {})
    })

    it("holds the insertion position while staging and keeps it once the resource is ready", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("hello world") })
        const pending = deferred<InputResourceStageResults>()
        client.stageInputUris.mockReturnValue(pending.promise)

        const staging = stageUris(engine, DRAFT_ID, ["file:///work/notes%20v2.md"], "uploaded_file", { start: 5, end: 5 })

        expect(flatTextOf(engine.getState().segments)).toBe(`hello${ATOM_PLACEHOLDER} world`)
        const [placeholder] = resources(engine)
        expect(placeholder).toMatchObject({ status: "staging", displayName: "notes v2.md", fileOrigin: "uploaded_file" })
        expect(client.stageInputUris).toHaveBeenCalledWith(
            expect.objectContaining({ draftId: DRAFT_ID, uris: ["file:///work/notes%20v2.md"] }),
        )

        pending.resolve(results(staged("res-1", "notes v2.md")))
        await staging

        expect(flatTextOf(engine.getState().segments)).toBe(`hello${ATOM_PLACEHOLDER} world`)
        expect(resources(engine)).toEqual([
            expect.objectContaining({ entityId: placeholder.entityId, status: "ready", ref: refOf("res-1"), nodeKind: "file" }),
        ])
    })

    it("keeps a failed resource in place with a retryable error", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("see ") })
        client.stageInputUris.mockResolvedValue(results(failure("input_resource_too_large")))

        await stageUris(engine, DRAFT_ID, ["file:///work/huge.log"], "uploaded_file")

        expect(resources(engine)).toEqual([
            expect.objectContaining({
                status: "failed",
                displayName: "huge.log",
                error: { code: "input_resource_too_large", message: "input_resource_too_large message", retryable: true },
            }),
        ])
        expect(resources(engine)[0].ref).toBeUndefined()
    })

    it("reports a generic stage failure when the host call itself throws", async () => {
        const engine = new SemanticComposerEngine()
        client.stageInputUris.mockRejectedValue(new Error("host unavailable"))

        await stageUris(engine, DRAFT_ID, ["file:///work/a.ts"], "uploaded_file")

        expect(resources(engine)[0]).toMatchObject({
            status: "failed",
            error: { code: "semantic_input_resource_stage_failed", retryable: true },
        })
    })

    it("retries only the failed item of a batch, under the same identity and position", async () => {
        const engine = new SemanticComposerEngine()
        const uris = ["file:///work/a.ts", "file:///work/b.ts"]
        client.stageInputUris.mockResolvedValueOnce(results(staged("res-a", "a.ts"), failure("input_resource_unreadable")))
        await stageUris(engine, DRAFT_ID, uris, "uploaded_file")
        const failed = resources(engine)[1]
        expect(failed.status).toBe("failed")

        const pending = deferred<InputResourceStageResults>()
        client.stageInputUris.mockReturnValueOnce(pending.promise)
        expect(retryResource(engine, failed.entityId)).toBe(true)

        expect(resources(engine)[1]).toMatchObject({ entityId: failed.entityId, status: "staging" })
        expect(resources(engine)[1].error).toBeUndefined()
        expect(client.stageInputUris).toHaveBeenLastCalledWith(expect.objectContaining({ draftId: DRAFT_ID, uris: [uris[1]] }))

        pending.resolve(results(staged("res-b", "b.ts")))
        await flush()

        expect(resources(engine).map((atom) => [atom.entityId, atom.status, atom.ref?.resourceId])).toEqual([
            [resources(engine)[0].entityId, "ready", "res-a"],
            [failed.entityId, "ready", "res-b"],
        ])
        expect(retryResource(engine, failed.entityId)).toBe(false)
    })

    it("can retry again after a retry fails", async () => {
        const engine = new SemanticComposerEngine()
        client.stageInputUris.mockResolvedValue(results(failure("input_resource_unreadable")))
        await stageUris(engine, DRAFT_ID, ["file:///work/a.ts"], "uploaded_file")
        const { entityId } = resources(engine)[0]

        expect(retryResource(engine, entityId)).toBe(true)
        await flush()
        expect(resources(engine)[0]).toMatchObject({ entityId, status: "failed" })

        client.stageInputUris.mockResolvedValue(results(staged("res-a", "a.ts")))
        expect(retryResource(engine, entityId)).toBe(true)
        await flush()
        expect(resources(engine)[0]).toMatchObject({ entityId, status: "ready" })
        expect(client.stageInputUris).toHaveBeenCalledTimes(3)
    })

    it("cannot retry a failed resource it did not stage, such as one from a restored draft", () => {
        const restored = failedResourceAtom(
            createReadyResourceAtom({ ref: refOf("res-x"), displayName: "x.md", nodeKind: "file", fileOrigin: "uploaded_file" }),
            {
                code: "input_resource_missing",
                message: "gone",
            },
        )
        const engine = new SemanticComposerEngine()
        engine.apply({ type: "insert_atom", atom: restored })

        expect(retryResource(engine, restored.entityId)).toBe(false)
        expect(resources(engine)[0]).toMatchObject({ entityId: restored.entityId, status: "failed" })
        expect(client.stageInputUris).not.toHaveBeenCalled()
    })

    it("keeps a removed failed resource retryable while undo can restore it", async () => {
        const engine = new SemanticComposerEngine()
        client.stageInputUris.mockResolvedValue(results(failure("input_resource_unreadable")))
        await stageUris(engine, DRAFT_ID, ["file:///work/a.ts"], "uploaded_file")
        const { entityId } = resources(engine)[0]

        engine.apply({ type: "remove_atom", entityId })
        engine.undo()

        expect(retryResource(engine, entityId)).toBe(true)
    })

    it("forgets the retry once a load leaves no reachable state holding the atom", async () => {
        const engine = new SemanticComposerEngine()
        client.stageInputUris.mockResolvedValue(results(failure("input_resource_unreadable")))
        await stageUris(engine, DRAFT_ID, ["file:///work/a.ts"], "uploaded_file")
        const segments = engine.getState().segments
        const { entityId } = resources(engine)[0]

        engine.apply({ type: "load", segments: [] })
        engine.apply({ type: "load", segments })

        expect(resources(engine)[0]).toMatchObject({ entityId, status: "failed" })
        expect(retryResource(engine, entityId)).toBe(false)
        expect(client.stageInputUris).toHaveBeenCalledOnce()
    })

    it("revokes a preview URL only once no reachable state holds its atom", async () => {
        const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
        const revokeObjectURL = vi.fn()
        URL.createObjectURL = vi.fn(() => "blob:preview-1")
        URL.revokeObjectURL = revokeObjectURL
        try {
            const engine = new SemanticComposerEngine()
            client.stageInputBytes.mockResolvedValue(
                results(staged("res-img", "shot.png", InputResourceKind.INPUT_RESOURCE_KIND_IMAGE)),
            )
            await stageFiles(
                engine,
                DRAFT_ID,
                [new File([new Uint8Array([1])], "shot.png", { type: "image/png" })],
                "pasted_file",
            )
            const segments = engine.getState().segments
            expect(resources(engine)[0].previewUrl).toBe("blob:preview-1")

            // A load whose undo step still holds the atom keeps the preview alive.
            engine.apply({ type: "load", segments: [], undoTo: segments })
            expect(revokeObjectURL).not.toHaveBeenCalled()

            engine.apply({ type: "load", segments: [] })
            expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1")
        } finally {
            URL.createObjectURL = original.create
            URL.revokeObjectURL = original.revoke
        }
    })

    it("does not retry an atom that is no longer failed or no longer in the draft", async () => {
        const engine = new SemanticComposerEngine()
        client.stageInputUris.mockResolvedValue(results(failure("input_resource_unreadable")))
        await stageUris(engine, DRAFT_ID, ["file:///work/a.ts"], "uploaded_file")
        const { entityId } = resources(engine)[0]

        engine.apply({ type: "remove_atom", entityId })

        expect(retryResource(engine, entityId)).toBe(false)
        expect(client.stageInputUris).toHaveBeenCalledTimes(1)
    })

    it("leaves an attachment the user removed while it was staging removed", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("text") })
        const pending = deferred<InputResourceStageResults>()
        client.stageInputUris.mockReturnValue(pending.promise)

        const staging = stageUris(engine, DRAFT_ID, ["file:///work/a.ts"], "uploaded_file")
        engine.apply({ type: "remove_atom", entityId: resources(engine)[0].entityId })
        pending.resolve(results(staged("res-a", "a.ts")))
        await staging

        expect(resources(engine)).toEqual([])
        expect(flatTextOf(engine.getState().segments)).toBe("text")
    })

    it("stages a long paste as a pasted-text resource with its line count", async () => {
        const engine = new SemanticComposerEngine()
        client.stageInputText.mockResolvedValue(
            results(staged("res-p", "pasted.txt", InputResourceKind.INPUT_RESOURCE_KIND_PASTED_TEXT, 3)),
        )

        await stagePastedText(engine, DRAFT_ID, "a\nb\nc")

        expect(client.stageInputText).toHaveBeenCalledWith(expect.objectContaining({ draftId: DRAFT_ID, text: "a\nb\nc" }))
        expect(resources(engine)).toEqual([
            expect.objectContaining({ status: "ready", fileOrigin: "pasted_text", lineCount: 3, displayName: "pasted.txt" }),
        ])
    })

    it("inserts what the file dialog staged at the caret, in the order returned", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("ab") })
        engine.apply({ type: "select", selection: { anchor: 1, focus: 1 } })
        client.selectInputResources.mockResolvedValue(
            results(
                staged("res-img", "shot.png", InputResourceKind.INPUT_RESOURCE_KIND_IMAGE),
                failure("input_resource_too_large", "big.bin"),
            ),
        )

        await stageSelectedResources(engine, DRAFT_ID, false, 3)

        expect(client.selectInputResources).toHaveBeenCalledWith(
            expect.objectContaining({ draftId: DRAFT_ID, imagesAllowed: false, maxCount: 3 }),
        )
        expect(flatTextOf(engine.getState().segments)).toBe(`a${ATOM_PLACEHOLDER}${ATOM_PLACEHOLDER}b`)
        expect(resources(engine)).toEqual([
            expect.objectContaining({ status: "ready", nodeKind: "image", displayName: "shot.png" }),
            expect.objectContaining({
                status: "failed",
                displayName: "big.bin",
                error: expect.objectContaining({ code: "input_resource_too_large" }),
            }),
        ])
    })

    it("inserts nothing when the file dialog is cancelled or fails", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("ab") })
        client.selectInputResources.mockResolvedValueOnce(results())
        await stageSelectedResources(engine, DRAFT_ID, true, 5)
        client.selectInputResources.mockRejectedValueOnce(new Error("dialog failed"))
        await stageSelectedResources(engine, DRAFT_ID, true, 5)

        expect(flatTextOf(engine.getState().segments)).toBe("ab")
    })

    // The dialog was opened for one draft; its files belong to that draft only.
    it("drops picked files when another draft is loaded while the dialog is open", async () => {
        const engine = new SemanticComposerEngine({ initial: stateFromText("ab") })
        client.selectInputResources.mockImplementationOnce(async () => {
            engine.apply({ type: "load", segments: [{ kind: "text", text: "other draft", source: "typed" }] })
            return results(staged("res-late", "late.txt"))
        })

        await stageSelectedResources(engine, DRAFT_ID, true, 5)

        expect(flatTextOf(engine.getState().segments)).toBe("other draft")
    })
})

describe("resource staging capacity", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, "warn").mockImplementation(() => {})
    })

    it("admits only as many items as the draft has room for and reports the rest", () => {
        const engine = engineWithResources(19)
        const onLimit = vi.fn()
        client.stageInputUris.mockReturnValue(new Promise(() => {}))

        void stageUris(
            engine,
            DRAFT_ID,
            ["file:///work/a.md", "file:///work/b.md", "file:///work/c.md"],
            "uploaded_file",
            undefined,
            onLimit,
        )

        expect(resources(engine)).toHaveLength(20)
        expect(client.stageInputUris).toHaveBeenCalledWith(expect.objectContaining({ uris: ["file:///work/a.md"] }))
        expect(onLimit).toHaveBeenCalledExactlyOnceWith(2)
    })

    it("counts attachments still staging, so inputs in flight together cannot exceed the limit", () => {
        const engine = engineWithResources(18)
        const onLimit = vi.fn()
        client.stageInputUris.mockReturnValue(new Promise(() => {}))

        void stageUris(engine, DRAFT_ID, ["file:///work/a.md", "file:///work/b.md"], "uploaded_file")
        void stagePastedText(engine, DRAFT_ID, "a\nb", undefined, onLimit)

        expect(resources(engine)).toHaveLength(20)
        expect(client.stageInputText).not.toHaveBeenCalled()
        expect(onLimit).toHaveBeenCalledExactlyOnceWith(1)
    })

    it("does not report a limit when everything fits", async () => {
        const engine = new SemanticComposerEngine()
        const onLimit = vi.fn()
        client.stageInputUris.mockResolvedValue(results(staged("res-a", "a.md")))

        await stageUris(engine, DRAFT_ID, ["file:///work/a.md"], "uploaded_file", undefined, onLimit)

        expect(onLimit).not.toHaveBeenCalled()
    })
})

describe("resource staging lifetime", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, "warn").mockImplementation(() => {})
    })

    it("releases the preview of an attachment whose draft was replaced while it was staging", async () => {
        await withObjectUrls(async (revoke) => {
            const engine = new SemanticComposerEngine()
            const pending = deferred<InputResourceStageResults>()
            client.stageInputBytes.mockReturnValue(pending.promise)

            const staging = stageFiles(engine, DRAFT_ID, [image("shot.png")], "pasted_file")
            const { entityId } = resources(engine)[0]
            engine.apply({ type: "load", segments: [] })
            expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:preview-1")

            pending.resolve(results(failure("input_resource_unreadable")))
            await staging

            expect(resources(engine)).toEqual([])
            expect(retryResource(engine, entityId)).toBe(false)
            expect(revoke).toHaveBeenCalledOnce()
        })
    })

    it("releases every preview when the composer goes away, and only once", async () => {
        await withObjectUrls(async (revoke) => {
            const engine = new SemanticComposerEngine()
            client.stageInputBytes.mockResolvedValue(
                results(
                    staged("res-1", "one.png", InputResourceKind.INPUT_RESOURCE_KIND_IMAGE),
                    staged("res-2", "two.png", InputResourceKind.INPUT_RESOURCE_KIND_IMAGE),
                ),
            )
            await stageFiles(engine, DRAFT_ID, [image("one.png"), image("two.png")], "pasted_file")
            expect(revoke).not.toHaveBeenCalled()

            releaseStaging(engine)
            expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(["blob:preview-1", "blob:preview-2"])

            engine.apply({ type: "load", segments: [] })
            expect(revoke).toHaveBeenCalledTimes(2)
        })
    })

    it("does not stage a recalled draft's files into another draft loaded while its images were staged", async () => {
        // jsdom's Blob may lack arrayBuffer; the bytes must reach the host for the load to happen mid-staging.
        const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer")
        Object.defineProperty(Blob.prototype, "arrayBuffer", {
            configurable: true,
            writable: true,
            value: async () => new ArrayBuffer(1),
        })
        try {
            const engine = new SemanticComposerEngine({ initial: stateFromText("recalled") })
            client.stageInputBytes.mockImplementationOnce(async () => {
                engine.apply({ type: "load", segments: [{ kind: "text", text: "other draft", source: "typed" }] })
                return results(staged("res-img", "image-1.png", InputResourceKind.INPUT_RESOURCE_KIND_IMAGE))
            })

            await stageLegacyAttachments(engine, DRAFT_ID, ["data:image/png;base64,AQ=="], ["/work/a.md"])

            expect(client.stageInputBytes).toHaveBeenCalledOnce()
            expect(client.stageInputUris).not.toHaveBeenCalled()
            expect(flatTextOf(engine.getState().segments)).toBe("other draft")
        } finally {
            if (descriptor) Object.defineProperty(Blob.prototype, "arrayBuffer", descriptor)
            else Reflect.deleteProperty(Blob.prototype, "arrayBuffer")
        }
    })
})
