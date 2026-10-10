import { beforeEach, describe, expect, it, vi } from "vitest"
import {
    ContextTransitionEngine,
    type ContextTransitionPhase,
    type ContextTransitionPolicy,
    type ContextTransitionPreparation,
} from "../ContextTransitionEngine"
import { ContextTransitionLease } from "../ContextTransitionLease"

/**
 * P0 regression guard for a Profile switch that stays stuck in preflight.
 *
 * Preflight awaits an expensive context projection. When the transition became stale
 * during that await, the engine returned early without clearing the active transition
 * or releasing the shared lease. Every later request then reported `in_progress`, so
 * the Profile selector stayed disabled until the extension restarted.
 */

interface TestRequest {
    taskId: string
}

interface TestOperation {
    operationId: string
    taskId: string
}

interface PolicyOverrides {
    prepare?: (request: TestRequest, operationId: string) => Promise<ContextTransitionPreparation<TestOperation>>
    validate?: (operation: TestOperation) => boolean
    commit?: (operation: TestOperation) => Promise<void>
}

/**
 * Build a minimal profile-kind policy for engine-level tests.
 *
 * @param overrides Behaviour overrides for the exercised transition step.
 * @returns The policy passed to the engine.
 */
function createPolicy(overrides: PolicyOverrides = {}): ContextTransitionPolicy<TestRequest, TestOperation, { phase: never }> {
    return {
        kind: "profile",
        confirmationOrder: "commit_then_compact",
        prepare:
            overrides.prepare ??
            (async (request, operationId) => ({ kind: "direct", operation: { operationId, taskId: request.taskId } })),
        validate: overrides.validate ?? (() => true),
        createCompactionRequest: () => {
            throw new Error("Compaction is not exercised by this test")
        },
        commit: overrides.commit ?? (async () => {}),
        createSnapshot: (operation: TestOperation, phase: ContextTransitionPhase, error?: string) =>
            ({ phase, operationId: operation.operationId, error }) as never,
        cancelledError: () => "cancelled",
        compactionError: () => "compaction failed",
        staleConfirmationError: () => "stale confirmation",
        staleCancellationError: () => "stale cancellation",
        stateChangedError: () => "Profile switch state changed before commit.",
    } as unknown as ContextTransitionPolicy<TestRequest, TestOperation, { phase: never }>
}

describe("ContextTransitionEngine preflight lease release", () => {
    let lease: ContextTransitionLease
    let engine: ContextTransitionEngine
    let operationSequence: number

    beforeEach(() => {
        lease = new ContextTransitionLease()
        operationSequence = 0
        engine = new ContextTransitionEngine({
            lease,
            compaction: { compact: vi.fn(), abort: vi.fn(), complete: vi.fn() } as never,
            postState: async () => {},
            createId: () => `operation-${++operationSequence}`,
        })
    })

    it("releases the lease when the transition goes stale during preflight", async () => {
        // The lease is stolen while the expensive context projection is still awaited.
        const policy = createPolicy({
            prepare: async (request, operationId) => {
                lease.release(operationId)
                lease.acquire({ kind: "profile", operationId: "intruder", taskId: "other-task" })
                lease.release("intruder")
                return { kind: "direct", operation: { operationId, taskId: request.taskId } }
            },
        })

        const first = await engine.request(policy, { taskId: "task-1" })

        expect(first.status).toBe("rejected")
        expect(lease.getActive()).toBeUndefined()
        expect(engine.getSnapshot("profile").phase).toBe("idle")
    })

    it("accepts a later Profile switch after a stale preflight", async () => {
        const stalePolicy = createPolicy({
            prepare: async (request, operationId) => {
                lease.release(operationId)
                return { kind: "direct", operation: { operationId, taskId: request.taskId } }
            },
        })
        await engine.request(stalePolicy, { taskId: "task-1" })

        // Without releasing the stale transition this second request reported in_progress forever.
        const retry = await engine.request(createPolicy(), { taskId: "task-1" })

        expect(retry.status).toBe("switched")
        expect(lease.getActive()).toBeUndefined()
    })

    it("releases the lease when validation rejects before an operation is recorded", async () => {
        const policy = createPolicy({ validate: () => false })

        const rejected = await engine.request(policy, { taskId: "task-1" })

        expect(rejected.status).toBe("rejected")
        expect(rejected.error).toBe("Profile switch state changed before commit.")
        expect(lease.getActive()).toBeUndefined()

        const retry = await engine.request(createPolicy(), { taskId: "task-1" })
        expect(retry.status).toBe("switched")
    })

    it("releases the lease when commit throws during a direct switch", async () => {
        const policy = createPolicy({
            commit: async () => {
                throw new Error("commit exploded")
            },
        })

        const rejected = await engine.request(policy, { taskId: "task-1" })

        expect(rejected.status).toBe("rejected")
        expect(lease.getActive()).toBeUndefined()

        const retry = await engine.request(createPolicy(), { taskId: "task-1" })
        expect(retry.status).toBe("switched")
    })
})
