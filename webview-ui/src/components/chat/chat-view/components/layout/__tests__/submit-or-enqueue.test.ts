import { describe, expect, it } from "vitest"
import { resolveSendDisposition } from "../submit-or-enqueue"

/**
 * One send contract shared by every entry point: the Enter key, the send
 * button and a resume all decide the same way.
 *
 * A send is attempted first. Only a send that cannot go out is handed to the
 * queue, and a send is never silently dropped: every disposition either
 * submits or retains the draft somewhere the user can still reach it.
 */
describe("resolveSendDisposition", () => {
    it("submits when the composer can send", () => {
        expect(resolveSendDisposition({ canSubmit: true, queueCanDeliver: true })).toBe("submit")
    })

    it("submits even when the queue could not deliver, because submitting is tried first", () => {
        expect(resolveSendDisposition({ canSubmit: true, queueCanDeliver: false })).toBe("submit")
    })

    it("enqueues when the send cannot go out but the task still reaches a delivery point", () => {
        expect(resolveSendDisposition({ canSubmit: false, queueCanDeliver: true })).toBe("enqueue")
    })

    it("retains the draft in the composer when it can neither be sent nor delivered later", () => {
        // Never "drop": the draft stays visible so the user can send it again.
        expect(resolveSendDisposition({ canSubmit: false, queueCanDeliver: false })).toBe("retain")
    })

    it("never reports a disposition that discards the draft", () => {
        const dispositions = [true, false].flatMap((canSubmit) =>
            [true, false].map((queueCanDeliver) => resolveSendDisposition({ canSubmit, queueCanDeliver })),
        )
        expect(dispositions).toEqual(expect.arrayContaining(["submit", "enqueue", "retain"]))
        expect(dispositions).toHaveLength(4)
    })
})
