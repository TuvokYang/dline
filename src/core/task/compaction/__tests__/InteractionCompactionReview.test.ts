import { describe, expect, it } from "vitest"
import { CompactionReviewWithdrawnError } from "../../executors/compaction/ProductionCompactionAdapter"
import { InteractionCancellationError } from "../../interaction/InteractionCancellationError"
import type { InteractionOutcome, OpenInteractionRequest } from "../../interaction/InteractionProtocol"
import { type CompactionReviewDialogPort, InteractionCompactionReview } from "../InteractionCompactionReview"

function answering(...outcomes: InteractionOutcome[]) {
    const opened: OpenInteractionRequest[] = []
    const dialogs: CompactionReviewDialogPort = {
        open: async (request) => {
            opened.push(request)
            const outcome = outcomes.shift()
            if (!outcome) throw new Error("no scripted outcome")
            return outcome
        },
    }
    return { dialogs, opened }
}

function reviewInput(signal = new AbortController().signal) {
    return { compactionId: "compaction:1", attempt: "compaction:1:1", summary: "THE SUMMARY", signal }
}

describe("InteractionCompactionReview", () => {
    it("accepts the summary when the user condenses", async () => {
        const probe = answering({ actionId: "confirm_utility" })

        const decision = await new InteractionCompactionReview(probe.dialogs).review(reviewInput())

        expect(decision).toEqual({ action: "accept" })
        expect(probe.opened).toEqual([
            {
                turnId: "compaction:1",
                interactionId: "compaction:1:1:review:0",
                kind: "condense",
                presentation: "THE SUMMARY",
                placement: "interrupt",
            },
        ])
    })

    it("takes over the row the run's progress card was drawn on", async () => {
        const probe = answering({ actionId: "confirm_utility" })

        await new InteractionCompactionReview(probe.dialogs).review({ ...reviewInput(), existingTs: 42 })

        expect(probe.opened[0]?.existingTs).toBe(42)
    })

    it("regenerates with what the user typed when they reject", async () => {
        const probe = answering({ actionId: "reject", draft: { text: "  mention the tests  ", images: [], files: [] } })

        const decision = await new InteractionCompactionReview(probe.dialogs).review(reviewInput())

        expect(decision).toEqual({ action: "regenerate", feedback: "mention the tests" })
    })

    it("regenerates without feedback when the rejection carried no draft", async () => {
        const probe = answering({ actionId: "reject" })

        const decision = await new InteractionCompactionReview(probe.dialogs).review(reviewInput())

        expect(decision).toEqual({ action: "regenerate", feedback: "" })
    })

    it("opens a distinct interaction for every regenerated summary", async () => {
        const probe = answering({ actionId: "reject" }, { actionId: "confirm_utility" })
        const review = new InteractionCompactionReview(probe.dialogs)

        await review.review(reviewInput())
        await review.review(reviewInput())

        expect(probe.opened.map((request) => request.interactionId)).toEqual([
            "compaction:1:1:review:0",
            "compaction:1:1:review:1",
        ])
    })

    // A round still in flight may end on a dialog of its own; a review that
    // held the slot first would make the kernel refuse it.
    it("opens only once the slot says the review may take it", async () => {
        const probe = answering({ actionId: "confirm_utility" })
        let release: () => void = () => undefined
        const asked: string[] = []
        const review = new InteractionCompactionReview(probe.dialogs, {
            reviewable: (compactionId) => {
                asked.push(compactionId)
                return new Promise<void>((resolve) => {
                    release = resolve
                })
            },
        })

        const decision = review.review(reviewInput())
        await Promise.resolve()
        expect(asked).toEqual(["compaction:1"])
        expect(probe.opened).toEqual([])

        release()
        await expect(decision).resolves.toEqual({ action: "accept" })
        expect(probe.opened).toHaveLength(1)
    })

    it("opens nothing when the run stops while it waits for the slot", async () => {
        const probe = answering({ actionId: "confirm_utility" })
        const controller = new AbortController()
        const review = new InteractionCompactionReview(probe.dialogs, {
            reviewable: async () => {
                controller.abort(new Error("stopped"))
            },
        })

        await expect(review.review(reviewInput(controller.signal))).rejects.toThrow("stopped")
        expect(probe.opened).toEqual([])
    })

    it("reports a dialog withdrawn by a stop as a withdrawn review, not a failure", async () => {
        const dialogs: CompactionReviewDialogPort = {
            open: async () => {
                throw new InteractionCancellationError("dialog_cancel")
            },
        }

        await expect(new InteractionCompactionReview(dialogs).review(reviewInput())).rejects.toBeInstanceOf(
            CompactionReviewWithdrawnError,
        )
    })

    it("opens nothing once the run was stopped", async () => {
        const probe = answering({ actionId: "confirm_utility" })
        const controller = new AbortController()
        controller.abort(new Error("stopped"))

        await expect(new InteractionCompactionReview(probe.dialogs).review(reviewInput(controller.signal))).rejects.toThrow(
            "stopped",
        )
        expect(probe.opened).toEqual([])
    })
})
