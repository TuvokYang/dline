import type { ChatContent } from "@shared/ChatContent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
    type ContextTransitionCompactionRequest,
    type ContextTransitionConfirmationOrder,
    ContextTransitionEngine,
    type ContextTransitionPhase,
    type ContextTransitionPolicy,
    type ContextTransitionSnapshot,
    type TransitionDraftCarrier,
    type TransitionDraftDelivery,
    type TransitionDraftHold,
    type TransitionDraftSource,
} from "../ContextTransitionEngine"
import { ContextTransitionLease } from "../ContextTransitionLease"

/**
 * The engine owns when a transition's draft is kept and delivered, so every
 * transition kind gets the same ordering: kept before a confirmation becomes
 * visible, delivered only as the last step of a committed transition.
 */

interface TestRequest {
    taskId: string
    chatContent?: ChatContent
}

interface TestOperation {
    operationId: string
    taskId: string
    chatContent?: ChatContent
}

const DRAFT: ChatContent = { message: "E2E_DRAFT" }

function createPolicy(options: {
    kind: "mode" | "profile"
    order: ContextTransitionConfirmationOrder
    confirm: boolean
    compacts: boolean
    log: string[]
    commit?: () => Promise<void>
}): ContextTransitionPolicy<TestRequest, TestOperation, ContextTransitionSnapshot> {
    return {
        kind: options.kind,
        confirmationOrder: options.order,
        prepare: async (request, operationId) => ({
            kind: options.confirm ? "confirm" : "direct",
            operation: { operationId, taskId: request.taskId, chatContent: request.chatContent },
        }),
        validate: () => true,
        ...(options.compacts
            ? {
                  createCompactionRequest: (operation: TestOperation): ContextTransitionCompactionRequest =>
                      ({ operationId: operation.operationId }) as ContextTransitionCompactionRequest,
              }
            : {}),
        commit: async () => {
            options.log.push("commit")
            await options.commit?.()
        },
        createSnapshot: (operation: TestOperation, phase: ContextTransitionPhase, error?: string) => ({
            phase,
            operationId: operation.operationId,
            error,
        }),
        cancelledError: () => "cancelled",
        compactionError: () => "compaction failed",
        staleConfirmationError: () => "stale confirmation",
        staleCancellationError: () => "stale cancellation",
        stateChangedError: () => "state changed",
    }
}

describe("ContextTransitionEngine draft carrier", () => {
    let log: string[]
    let lease: ContextTransitionLease
    let hold: ReturnType<typeof vi.fn<(source: TransitionDraftSource) => Promise<TransitionDraftHold>>>
    let deliver: ReturnType<typeof vi.fn<(source: TransitionDraftSource) => Promise<TransitionDraftDelivery>>>
    let postState: ReturnType<typeof vi.fn<() => Promise<void>>>
    let engine: ContextTransitionEngine

    function createEngine(draftCarrier: TransitionDraftCarrier | null = { hold, deliver }): ContextTransitionEngine {
        return new ContextTransitionEngine({
            lease,
            compaction: {
                compact: vi.fn(async () => {
                    log.push("compact")
                    return "completed" as const
                }),
                complete: vi.fn(async () => {
                    log.push("release-barrier")
                }),
                abort: vi.fn(async () => {}),
            },
            postState,
            createId: () => "operation-1",
            ...(draftCarrier ? { draftCarrier } : {}),
        })
    }

    beforeEach(() => {
        log = []
        lease = new ContextTransitionLease()
        hold = vi.fn(async () => {
            log.push("hold")
            return "held" as const
        })
        deliver = vi.fn(async () => {
            log.push("deliver")
            return "delivered" as const
        })
        postState = vi.fn(async () => {
            log.push(`publish:${engine.getSnapshot("mode").phase}/${engine.getSnapshot("profile").phase}`)
        })
        engine = createEngine()
    })

    it("delivers the draft of a direct switch after the commit and reports it", async () => {
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: false, compacts: false, log })

        const result = await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        expect(result).toEqual({ status: "switched", operationId: "operation-1", draftDelivered: true })
        expect(log.indexOf("deliver")).toBeGreaterThan(log.indexOf("commit"))
        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", chatContent: DRAFT }))
        expect(hold).not.toHaveBeenCalled()
    })

    it("reports nothing about a draft that was empty or a host that carries none", async () => {
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: false, compacts: false, log })
        deliver.mockResolvedValueOnce("empty")

        await expect(engine.request(policy, { taskId: "task-1" })).resolves.toEqual({
            status: "switched",
            operationId: "operation-1",
        })
        engine = createEngine(null)
        await expect(engine.request(policy, { taskId: "task-1", chatContent: DRAFT })).resolves.toEqual({
            status: "switched",
            operationId: "operation-1",
        })
    })

    it("keeps the draft before the confirmation becomes visible", async () => {
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: true, compacts: false, log })

        const result = await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        expect(result.status).toBe("confirmation_required")
        expect(log.indexOf("hold")).toBeGreaterThanOrEqual(0)
        expect(log.indexOf("hold")).toBeLessThan(log.indexOf("publish:idle/awaiting_confirmation"))
        expect(deliver).not.toHaveBeenCalled()
    })

    it.each([
        ["reports it could not keep the draft", async () => "failed" as const],
        [
            "throws while keeping the draft",
            async (): Promise<TransitionDraftHold> => {
                throw new Error("disk full")
            },
        ],
    ])("never waits on a confirmation when the carrier %s", async (_label, failingHold) => {
        hold.mockImplementationOnce(failingHold)
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: true, compacts: false, log })

        const result = await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        expect(result.status).toBe("rejected")
        expect(result.error).toContain("could not be kept")
        expect(engine.getSnapshot("profile").phase).toBe("failed")
        expect(log).not.toContain("publish:idle/awaiting_confirmation")
        expect(lease.getActive()).toBeUndefined()
    })

    it("delivers the draft of a compacting switch only after the compaction barrier was released", async () => {
        const policy = createPolicy({ kind: "mode", order: "compact_then_commit", confirm: true, compacts: true, log })
        await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        const result = await engine.confirm("operation-1")

        expect(result).toEqual({ status: "switched", operationId: "operation-1", draftDelivered: true })
        expect(log.filter((step) => !step.startsWith("publish"))).toEqual([
            "hold",
            "compact",
            "commit",
            "release-barrier",
            "deliver",
        ])
    })

    it("delivers the draft of an acknowledged notice after the commit", async () => {
        deliver.mockImplementationOnce(async () => {
            log.push("deliver")
            return "undelivered"
        })
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: true, compacts: false, log })
        await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        const result = await engine.confirm("operation-1")

        expect(result).toEqual({ status: "switched", operationId: "operation-1", draftDelivered: false })
        expect(log.indexOf("deliver")).toBeGreaterThan(log.indexOf("commit"))
    })

    it("still reports a delivered draft when the settled state cannot be published", async () => {
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: true, compacts: false, log })
        await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })
        postState.mockImplementation(async () => {
            if (log.includes("deliver")) throw new Error("webview gone")
        })

        const result = await engine.confirm("operation-1")

        expect(result).toEqual({ status: "switched", operationId: "operation-1", draftDelivered: true })
        expect(lease.getActive()).toBeUndefined()
    })

    it("reports a draft whose delivery threw as not delivered", async () => {
        deliver.mockRejectedValueOnce(new Error("dispatch exploded"))
        const policy = createPolicy({ kind: "profile", order: "commit_then_compact", confirm: false, compacts: false, log })

        const result = await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        expect(result).toEqual({ status: "switched", operationId: "operation-1", draftDelivered: false })
    })

    it("never delivers the draft of a cancelled or failed transition", async () => {
        const policy = createPolicy({
            kind: "profile",
            order: "commit_then_compact",
            confirm: true,
            compacts: false,
            log,
            commit: async () => {
                throw new Error("commit exploded")
            },
        })
        await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })
        await engine.cancel("operation-1")
        await engine.request(policy, { taskId: "task-1", chatContent: DRAFT })

        const failed = await engine.confirm("operation-1")

        expect(failed.status).toBe("rejected")
        expect(deliver).not.toHaveBeenCalled()
    })
})
