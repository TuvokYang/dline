import type { CompactionPassIdentity } from "@core/context/context-management/target-window-fitting"
import { describe, expect, it } from "vitest"
import { ContextCompactionPresentation } from "../ContextCompactionPresentation"

function pass(passIndex: number, history = `history-${passIndex}`): CompactionPassIdentity {
    return {
        operationId: "operation-1",
        passIndex,
        passStartTurnIndex: passIndex,
        passEndTurnIndex: passIndex,
        coveredTurnCount: passIndex,
        summaryBaselineHash: `summary-${passIndex}`,
        passHistoryHash: history,
    }
}

const attempt0 = { attemptIndex: 0, authorizationAttemptId: "attempt-0" }
const attempt1 = { attemptIndex: 1, authorizationAttemptId: "attempt-1" }

describe("ContextCompactionPresentation execution units", () => {
    it("keeps one timestamp through the complete ordinary Pass lifecycle", () => {
        const presentation = new ContextCompactionPresentation()
        const identity = pass(0)

        expect(presentation.preparePass("operation-1", 0)).toMatchObject({
            operationId: "operation-1",
            unitKind: "pass",
            unitIndex: 0,
            status: "preparing",
        })
        const preparing = presentation.getUnitSnapshot("operation-1", "pass", 0)
        if (!preparing) throw new Error("Prepared Pass card is unavailable")
        expect(presentation.bindMessageTs(preparing, 101)).toBe(true)
        expect(presentation.startPass(identity, attempt0)).toMatchObject({ existingTs: 101, status: "waiting" })
        expect(presentation.receiving(identity, attempt0)).toMatchObject({ existingTs: 101, status: "receiving" })
        expect(presentation.partial(identity, attempt0, "partial zero")).toMatchObject({
            existingTs: 101,
            content: "partial zero",
            status: "receiving",
        })
        expect(presentation.retry(identity, attempt0, attempt1, 1, 3, "network failure")).toMatchObject({
            existingTs: 101,
            status: "retrying",
            attempt: attempt1,
        })
        expect(presentation.complete(identity, attempt1, "completed summary")).toMatchObject({
            existingTs: 101,
            content: "completed summary",
            status: "completed",
        })
    })

    it("owns ordinary Pass and summary-refit cards independently", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)
        const refitIdentity = pass(1, "refit-history")
        const secondPass = pass(1)

        presentation.preparePass("operation-1", 0)
        presentation.startPass(firstPass, attempt0)
        presentation.partial(firstPass, attempt0, "first summary")
        const firstPassSnapshot = presentation.getUnitSnapshot("operation-1", "pass", 0)
        if (!firstPassSnapshot) throw new Error("First Pass card is unavailable")
        presentation.bindMessageTs(firstPassSnapshot, 101)
        presentation.complete(firstPass, attempt0, "first summary")
        const completedFirstPass = presentation.getUnitSnapshot("operation-1", "pass", 0)
        if (!completedFirstPass) throw new Error("Completed first Pass card is unavailable")
        expect(presentation.markDurable(completedFirstPass)).toBe(true)

        expect(presentation.prepareSummaryRefit(refitIdentity, 0)).toMatchObject({
            unitKind: "summary_refit",
            unitIndex: 0,
            status: "preparing",
        })
        expect(presentation.startSummaryRefit(refitIdentity, 0, attempt0)).toMatchObject({ status: "waiting" })
        expect(presentation.partialSummaryRefit(refitIdentity, attempt0, "smaller summary")).toMatchObject({
            status: "receiving",
        })
        expect(presentation.completeSummaryRefit(refitIdentity, attempt0, "smaller summary")).toMatchObject({
            status: "completed",
        })

        presentation.preparePass("operation-1", 1)
        presentation.startPass(secondPass, attempt0)
        expect(presentation.getSnapshots("operation-1")).toHaveLength(3)
        expect(presentation.getUnitSnapshot("operation-1", "pass", 0)).toMatchObject({
            content: "first summary",
            durable: true,
            status: "completed",
        })
        expect(presentation.getUnitSnapshot("operation-1", "summary_refit", 0)).toMatchObject({
            content: "smaller summary",
            status: "completed",
        })
        expect(presentation.getUnitSnapshot("operation-1", "pass", 1)).toMatchObject({ status: "waiting" })
    })

    it("creates a separate durable-eligible failure card after a completed unit", () => {
        const presentation = new ContextCompactionPresentation()
        const identity = pass(0)

        presentation.preparePass("operation-1", 0)
        presentation.startPass(identity, attempt0)
        presentation.complete(identity, attempt0, "accepted summary")
        const failure = presentation.fail("operation-1", "The rebuilt target remains above the strict exit target.")

        expect(presentation.getUnitSnapshot("operation-1", "pass", 0)).toMatchObject({
            content: "accepted summary",
            status: "completed",
        })
        expect(failure).toMatchObject({
            operationId: "operation-1",
            unitKind: "failure",
            unitIndex: 0,
            content: "",
            status: "failed",
            error: "The rebuilt target remains above the strict exit target.",
        })
    })

    it("fails the current preparing card and selects only the latest undurable completed Pass for final commit", () => {
        const presentation = new ContextCompactionPresentation()
        const firstPass = pass(0)
        const secondPass = pass(1)

        presentation.preparePass("operation-1", 0)
        expect(presentation.fail("operation-1", "Planner failed")).toMatchObject({
            unitKind: "pass",
            unitIndex: 0,
            status: "failed",
        })
        presentation.clear("operation-1")

        presentation.preparePass("operation-1", 0)
        presentation.startPass(firstPass, attempt0)
        presentation.complete(firstPass, attempt0, "first")
        const completedFirstPass = presentation.getUnitSnapshot("operation-1", "pass", 0)
        if (!completedFirstPass) throw new Error("Completed first Pass card is unavailable")
        presentation.markDurable(completedFirstPass)
        presentation.preparePass("operation-1", 1)
        presentation.startPass(secondPass, attempt0)
        presentation.complete(secondPass, attempt0, "second")

        expect(presentation.finalizeOperation("operation-1")).toMatchObject({
            unitKind: "pass",
            unitIndex: 1,
            content: "second",
            status: "completed",
            durable: false,
        })
    })
})
