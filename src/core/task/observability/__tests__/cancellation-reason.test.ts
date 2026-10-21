import { describe, expect, it } from "vitest"
import { CompactionReviewWithdrawnError } from "../../executors/compaction/ProductionCompactionAdapter"
import { InteractionCancellationError } from "../../interaction/InteractionCancellationError"
import { cancellationReasonFor } from "../tool-execution-observation"

describe("cancellationReasonFor (WS-109 SC-2)", () => {
    it.each([
        "dialog_cancel",
        "dialog_terminate",
        "task_disposed",
    ])("treats an interaction withdrawn with %s as a cancellation, whatever its message says", (reason) => {
        expect(cancellationReasonFor(new InteractionCancellationError(reason))).toBe("task_interrupted")
    })

    it("treats a withdrawn compaction review as a cancellation", () => {
        expect(cancellationReasonFor(new CompactionReviewWithdrawnError("stop"))).toBe("task_interrupted")
    })

    it("classifies the abort names of the platform, VS Code and provider SDKs by name", () => {
        for (const name of ["AbortError", "CanceledError", "APIUserAbortError", "Canceled"]) {
            expect(cancellationReasonFor(Object.assign(new Error("boom"), { name }))).toBe("abort_error")
        }
    })

    it("keeps reporting a real failure as one", () => {
        expect(cancellationReasonFor(new Error("503 Service Unavailable"))).toBeUndefined()
        expect(cancellationReasonFor({ message: "aborted" })).toBeUndefined()
    })
})
