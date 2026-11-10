import { describe, expect, it, vi } from "vitest"
import type { InteractionOutcome } from "../../interaction/InteractionProtocol"
import { createInitialTaskState } from "../../kernel"
import { InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { LocalReportBugContinuation } from "../LocalReportBugContinuation"
import type { UnownedDialogResolution } from "../UnownedDialogContinuation"

function fallback() {
    return {
        accepts: vi.fn(() => true),
        prepare: vi.fn(async () => false),
        continue: vi.fn(async () => "continued" as const),
    }
}

function resolution(interactionId: string, kind = "report_bug"): UnownedDialogResolution {
    return { interactionId, kind, outcome: { actionId: "reject" } }
}

describe("LocalReportBugContinuation ownership", () => {
    it("delegates every non-local tool/recovery contract unchanged, including preparation refusal", async () => {
        const next = fallback()
        const continuation = new LocalReportBugContinuation(
            {
                state: () => createInitialTaskState("local"),
                writable: () => true,
                payloads: new InMemoryTaskPayloadStore(),
            },
            next,
        )
        for (const answer of [resolution("tool-block"), resolution("resume", "resume")]) {
            expect(continuation.accepts(answer)).toBe(true)
            expect(await continuation.prepare(answer)).toBe(false)
            expect(await continuation.continue(answer)).toBe("continued")
            expect(next.accepts).toHaveBeenCalledWith(answer)
            expect(next.prepare).toHaveBeenCalledWith(answer)
            expect(next.continue).toHaveBeenCalledWith(answer)
        }
    })

    it.each([
        "report_bug",
        "",
        "resume",
    ])("claims a stale local identity even with kind '%s', without generic Provider resumption", async (kind) => {
        const next = fallback()
        const continuation = new LocalReportBugContinuation(
            {
                state: () => createInitialTaskState("local"),
                writable: () => true,
                payloads: new InMemoryTaskPayloadStore(),
            },
            next,
        )
        const answer = resolution("report-bug-local:retired", kind)
        expect(continuation.accepts(answer)).toBe(true)
        expect(await continuation.prepare(answer)).toBe(true)
        expect(await continuation.continue(answer)).toBe("declined")
        expect(next.accepts).not.toHaveBeenCalled()
        expect(next.prepare).not.toHaveBeenCalled()
        expect(next.continue).not.toHaveBeenCalled()
    })

    it("coalesces one accepted response, retaining success for a retirement retry", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const presentationRef = await payloads.put(
            encodeTaskPayload({
                kind: "dialog_presentation",
                presentationKind: "report_bug",
                body: "preview without telemetry",
            }),
        )
        let release!: () => void
        const pending = new Promise<void>((resolve) => {
            release = resolve
        })
        const read = payloads.read.bind(payloads)
        const reads = vi.spyOn(payloads, "read").mockImplementation(async (ref) => {
            await pending
            return read(ref)
        })
        const base = createInitialTaskState("local")
        const answer = resolution("report-bug-local:coalesced")
        const response = { actionId: "reject", stateRevision: 0, receiverGeneration: 0 }
        const continuation = new LocalReportBugContinuation(
            {
                state: () => ({
                    ...base,
                    dialog: {
                        ...base.dialog,
                        primary: {
                            interactionId: answer.interactionId,
                            turnId: "local",
                            kind: "report_bug",
                            status: "resolving",
                            createdRevision: 0,
                            presentationRef,
                            actionRules: [],
                            acceptedResponse: response,
                        },
                    },
                }),
                writable: () => true,
                payloads,
            },
            fallback(),
        )
        const first = continuation.continue(answer)
        const duplicate = continuation.continue({ ...answer })
        expect(duplicate).toBe(first)
        release()
        await expect(first).resolves.toBe("continued")
        await expect(continuation.continue({ ...answer })).resolves.toBe("continued")
        expect(reads).toHaveBeenCalledOnce()
    })

    it("does not use the presentation as Confirm selection when the committed response has none", async () => {
        const payloads = new InMemoryTaskPayloadStore()
        const presentationRef = await payloads.put(
            encodeTaskPayload({
                kind: "dialog_presentation",
                presentationKind: "report_bug",
                body: "a persisted preview is not approval",
            }),
        )
        const state = createInitialTaskState("local")
        const outcome: InteractionOutcome = { actionId: "approve" }
        const interactionId = "report-bug-local:no-selection"
        const response = { actionId: "approve", stateRevision: 0, receiverGeneration: 0 }
        const continuation = new LocalReportBugContinuation(
            {
                state: () => ({
                    ...state,
                    dialog: {
                        ...state.dialog,
                        primary: {
                            interactionId,
                            turnId: "local",
                            kind: "report_bug",
                            status: "resolving",
                            createdRevision: 0,
                            presentationRef,
                            actionRules: [],
                            acceptedResponse: response,
                        },
                    },
                }),
                writable: () => true,
                payloads,
            },
            fallback(),
        )
        expect(await continuation.continue({ interactionId, kind: "report_bug", outcome })).toBe("failed")
    })
})
