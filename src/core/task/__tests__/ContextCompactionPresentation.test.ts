import type { CompactionPassIdentity } from "@core/context/context-management/target-window-fitting"
import { describe, expect, it } from "vitest"
import { ContextCompactionPresentation } from "../ContextCompactionPresentation"

function pass(passIndex: number): CompactionPassIdentity {
    return {
        operationId: "operation-1",
        passIndex,
        passStartTurnIndex: passIndex,
        passEndTurnIndex: passIndex,
        coveredTurnCount: passIndex,
        summaryBaselineHash: `summary-${passIndex}`,
        passHistoryHash: `history-${passIndex}`,
    }
}

const attempt0 = { attemptIndex: 0, authorizationAttemptId: "attempt-0" }
const attempt1 = { attemptIndex: 1, authorizationAttemptId: "attempt-1" }

/** Lock per-Pass card identity independently from Task message persistence. */
describe("ContextCompactionPresentation", () => {
    it("creates a waiting card before the first partial and keeps retry on the same Pass card", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)

        expect(presentation.startPass(firstPass, attempt0)).toMatchObject({ status: "waiting", attempt: attempt0 })
        const firstPartial = presentation.partial(firstPass, attempt0, "partial zero")
        expect(firstPartial).toMatchObject({
            content: "partial zero",
            status: "receiving",
            attempt: attempt0,
        })
        expect(firstPartial).not.toHaveProperty("existingTs")
        expect(presentation.bindMessageTs(firstPass, 101)).toBe(true)

        const retry = presentation.retry(firstPass, attempt0, attempt1, 1, 3, "network failure")
        expect(retry).toMatchObject({ existingTs: 101, content: "partial zero", status: "retrying", attempt: attempt1 })
        const retriedPartial = presentation.partial(firstPass, attempt1, "partial one")
        expect(retriedPartial).toMatchObject({ existingTs: 101, content: "partial one", status: "receiving", attempt: attempt1 })
    })

    it("keeps the Pass row identity when publishing terminal failure after rollback", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)

        presentation.startPass(firstPass, attempt0)
        presentation.partial(firstPass, attempt0, "partial zero")
        presentation.bindMessageTs(firstPass, 101)

        expect(presentation.fail("operation-1", "The summary stream timed out after checkpoint recovery.")).toMatchObject({
            existingTs: 101,
            content: "",
            status: "failed",
            error: "The summary stream timed out after checkpoint recovery.",
        })
    })

    it("preserves an accepted Pass card and creates a separate terminal failure card", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)

        presentation.startPass(firstPass, attempt0)
        presentation.partial(firstPass, attempt0, "accepted summary")
        presentation.bindMessageTs(firstPass, 101)
        presentation.complete(firstPass, attempt0, "accepted summary")

        expect(presentation.fail("operation-1", "The rebuilt target remains above the strict exit target.")).toMatchObject({
            unitKind: "failure",
            content: "",
            status: "failed",
            error: "The rebuilt target remains above the strict exit target.",
        })
        expect(presentation.getUnitSnapshot("operation-1", "pass", 0)).toMatchObject({
            existingTs: 101,
            content: "accepted summary",
            status: "completed",
        })
    })

    it("keeps an output-limit replay on the same card without inventing automatic retry totals", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)

        presentation.startPass(firstPass, attempt0)
        presentation.partial(firstPass, attempt0, "partial zero")
        presentation.bindMessageTs(firstPass, 101)

        expect(presentation.retry(firstPass, attempt0, attempt1)).toMatchObject({
            existingTs: 101,
            status: "retrying",
            attempt: attempt1,
            retryAttempt: undefined,
            maxRetryAttempts: undefined,
        })
    })

    it("allocates a separate row for each Pass and rejects stale Pass or attempt updates", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)
        const secondPass = pass(1)

        presentation.startPass(firstPass, attempt0)
        presentation.partial(firstPass, attempt0, "first")
        presentation.bindMessageTs(firstPass, 101)
        expect(presentation.complete(firstPass, attempt0, "completed first")).toMatchObject({
            existingTs: 101,
            content: "completed first",
            status: "completed",
        })

        expect(presentation.startPass(secondPass, attempt0)).toMatchObject({ content: "", status: "waiting" })
        expect(presentation.getSnapshot()).toMatchObject({ content: "", status: "waiting" })
        expect(presentation.getSnapshot()).not.toHaveProperty("existingTs")
        expect(presentation.partial(secondPass, attempt0, "second")).toMatchObject({ status: "receiving" })
        expect(presentation.getSnapshot()).not.toHaveProperty("existingTs")
        expect(presentation.bindMessageTs(secondPass, 202)).toBe(true)
        expect(presentation.partial(firstPass, attempt0, "late first")).toBeUndefined()
        expect(presentation.partial(secondPass, attempt1, "unannounced retry")).toBeUndefined()
        expect(presentation.complete(secondPass, attempt0, "second")).toMatchObject({ status: "completed" })
        expect(presentation.finalizeOperation("operation-1")).toMatchObject({
            existingTs: 202,
            content: "second",
            status: "completed",
        })
        expect(presentation.fail("operation-1", "Terminal compaction failure")).toMatchObject({
            unitKind: "failure",
            content: "",
            status: "failed",
            error: "Terminal compaction failure",
        })
        expect(presentation.getUnitSnapshot("operation-1", "pass", 1)).toMatchObject({
            existingTs: 202,
            content: "second",
            status: "completed",
        })
    })
})
