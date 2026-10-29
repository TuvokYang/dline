import type { ApiHandler } from "@core/api"
import { ContextTransitionLease } from "@core/controller/context-transition/ContextTransitionLease"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModeSwitchCoordinator } from "../ModeSwitchCoordinator"
import type {
    ContextPressureReader,
    ModeCommitPort,
    ModeProfileResolver,
    ModeSwitchOperation,
    ResolvedModeProfile,
    TaskCompactionPort,
} from "../types"

interface TestHarness {
    coordinator: ModeSwitchCoordinator
    lease: ContextTransitionLease
    profiles: ModeProfileResolver
    pressure: ContextPressureReader
    compaction: TaskCompactionPort
    commit: ModeCommitPort
    postState: ReturnType<typeof vi.fn<() => Promise<void>>>
    compact: ReturnType<
        typeof vi.fn<(request: Parameters<TaskCompactionPort["compact"]>[0]) => Promise<"completed" | "cancelled" | "failed">>
    >
    preflight: ReturnType<typeof vi.fn<(targetApi: ApiHandler, targetMode: Mode, chatContent?: ChatContent) => Promise<number>>>
    release: ReturnType<typeof vi.fn<(operationId: string) => Promise<void>>>
    fail: ReturnType<typeof vi.fn<(operationId: string, reason: string) => Promise<void>>>
    validate: ReturnType<typeof vi.fn<(operation: ModeSwitchOperation) => boolean>>
    commitMode: ReturnType<typeof vi.fn<ModeCommitPort["commit"]>>
    setTaskId: (taskId: string | undefined) => void
}

const SOURCE: ResolvedModeProfile = {
    mode: "plan",
    profileId: "large-id",
    profile: "large",
    contextWindow: 272_000,
    triggerTokens: 266_500,
    fittingExitTarget: 217_600,
}

const TARGET_API = { getModel: vi.fn() } as unknown as ApiHandler

const TARGET: ResolvedModeProfile = {
    mode: "act",
    profileId: "small-id",
    profile: "small",
    contextWindow: 128_000,
    triggerTokens: 117_500,
    fittingExitTarget: 102_400,
    executionApi: TARGET_API,
}

/** Build deterministic ports for one coordinator test. */
function createHarness(projectedUsageTokens = 128_001): TestHarness {
    let taskId: string | undefined = "task-1"
    const lease = new ContextTransitionLease()
    const resolve = vi.fn<(mode: Mode) => ResolvedModeProfile | undefined>((mode) => (mode === "plan" ? SOURCE : TARGET))
    const profiles: ModeProfileResolver = { getSource: () => SOURCE, resolve }
    const preflight = vi.fn<(targetApi: ApiHandler, targetMode: Mode, chatContent?: ChatContent) => Promise<number>>(
        async () => projectedUsageTokens,
    )
    const pressure: ContextPressureReader = { read: preflight }
    const compact = vi.fn<
        (request: Parameters<TaskCompactionPort["compact"]>[0]) => Promise<"completed" | "cancelled" | "failed">
    >(async () => "completed")
    const release = vi.fn<(operationId: string) => Promise<void>>(async () => undefined)
    const fail = vi.fn<(operationId: string, reason: string) => Promise<void>>(async () => undefined)
    const compaction: TaskCompactionPort = { compact, complete: release, abort: fail }
    const validate = vi.fn<(operation: ModeSwitchOperation) => boolean>(() => true)
    const commitMode = vi.fn<ModeCommitPort["commit"]>(async () => undefined)
    const commit: ModeCommitPort = { validate, commit: commitMode }
    const postState = vi.fn<() => Promise<void>>(async () => {})
    const coordinator = new ModeSwitchCoordinator({
        profiles,
        pressure,
        compaction,
        commit,
        lease,
        postState,
        createId: () => "operation-1",
        getTaskId: () => taskId,
    })
    return {
        coordinator,
        lease,
        profiles,
        pressure,
        compaction,
        commit,
        postState,
        compact,
        preflight,
        release,
        fail,
        validate,
        commitMode,
        setTaskId: (nextTaskId) => {
            taskId = nextTaskId
        },
    }
}

/** Verify the coordinator transaction matrix independently from Controller and Task. */
describe("ModeSwitchCoordinator", () => {
    let harness: TestHarness

    /** Create fresh deterministic ports for every scenario. */
    beforeEach(() => {
        harness = createHarness()
    })

    /** Directly commit only while the complete target candidate remains below the compaction trigger. */
    it("switches directly when the target candidate is one token below the compaction trigger", async () => {
        harness = createHarness(117_499)
        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result).toEqual({ status: "switched", operationId: "operation-1" })
        expect(harness.compact).not.toHaveBeenCalled()
        expect(harness.preflight).toHaveBeenCalledWith(TARGET_API, "act", undefined)
        expect(harness.commitMode).toHaveBeenCalledOnce()
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
    })

    /** Bypass preflight and the shared lease when split modes resolve to the same Profile, even above the target window. */
    it("switches directly for the same profile even when the target candidate exceeds the window", async () => {
        harness = createHarness(400_000)
        const acquire = vi.spyOn(harness.lease, "acquire")
        const sharedProfile: ModeProfileResolver = {
            getSource: () => ({ ...SOURCE, profile: "shared" }),
            resolve: (mode) => ({ ...SOURCE, mode, profile: "shared", executionApi: TARGET_API }),
        }
        harness.coordinator = new ModeSwitchCoordinator({
            profiles: sharedProfile,
            pressure: harness.pressure,
            compaction: harness.compaction,
            commit: harness.commit,
            lease: harness.lease,
            postState: harness.postState,
            createId: () => "operation-1",
            getTaskId: () => "task-1",
        })

        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result.status).toBe("switched")
        expect(harness.preflight).not.toHaveBeenCalled()
        expect(acquire).not.toHaveBeenCalled()
        expect(harness.lease.getActive()).toBeUndefined()
        expect(harness.compact).not.toHaveBeenCalled()
        expect(harness.commitMode).toHaveBeenCalledOnce()
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
    })

    /** Treat duplicate display names with different stable IDs as different Profiles. */
    it("does not bypass preflight for different profile ids with the same display name", async () => {
        const acquire = vi.spyOn(harness.lease, "acquire")
        const duplicateNames: ModeProfileResolver = {
            getSource: () => ({ ...SOURCE, profileId: "source-id", profile: "duplicate" }),
            resolve: (mode) => ({ ...TARGET, mode, profileId: "target-id", profile: "duplicate", executionApi: TARGET_API }),
        }
        harness.coordinator = new ModeSwitchCoordinator({
            profiles: duplicateNames,
            pressure: harness.pressure,
            compaction: harness.compaction,
            commit: harness.commit,
            lease: harness.lease,
            postState: harness.postState,
            createId: () => "operation-1",
            getTaskId: () => "task-1",
        })

        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result).toEqual({ status: "confirmation_required", operationId: "operation-1" })
        expect(acquire).toHaveBeenCalledOnce()
        expect(harness.preflight).toHaveBeenCalledWith(TARGET_API, "act", undefined)
        expect(harness.commitMode).not.toHaveBeenCalled()
    })

    /** Serialize the actual same-Profile commit without publishing transition state or acquiring the shared lease. */
    it("rejects re-entry while a same-profile direct commit is unresolved", async () => {
        let resolveCommit: (() => void) | undefined
        harness.commitMode.mockReturnValueOnce(
            new Promise<undefined>((resolve) => {
                resolveCommit = () => resolve(undefined)
            }),
        )
        const acquire = vi.spyOn(harness.lease, "acquire")
        const sharedProfile: ModeProfileResolver = {
            getSource: () => ({ ...SOURCE, profile: "shared" }),
            resolve: (mode) => ({ ...SOURCE, mode, profile: "shared", executionApi: TARGET_API }),
        }
        harness.coordinator = new ModeSwitchCoordinator({
            profiles: sharedProfile,
            pressure: harness.pressure,
            compaction: harness.compaction,
            commit: harness.commit,
            lease: harness.lease,
            postState: harness.postState,
            createId: () => "operation-1",
            getTaskId: () => "task-1",
        })

        const first = harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        await Promise.resolve()
        const second = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(second).toEqual({ status: "in_progress", operationId: "operation-1" })
        expect(harness.preflight).not.toHaveBeenCalled()
        expect(acquire).not.toHaveBeenCalled()
        expect(harness.lease.getActive()).toBeUndefined()
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
        expect(harness.commitMode).toHaveBeenCalledOnce()
        resolveCommit?.()
        await expect(first).resolves.toEqual({ status: "switched", operationId: "operation-1" })
    })

    /** Project confirmation details when the complete target candidate reaches the compaction trigger. */
    it("requests confirmation when the target candidate reaches the compaction trigger", async () => {
        harness = createHarness(117_500)
        const acquire = vi.spyOn(harness.lease, "acquire")
        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result).toEqual({ status: "confirmation_required", operationId: "operation-1" })
        expect(harness.coordinator.getSnapshot()).toMatchObject({
            phase: "awaiting_confirmation",
            operationId: "operation-1",
            taskId: "task-1",
            sourceMode: "plan",
            targetMode: "act",
            currentTokens: 117_500,
            fittingExitTarget: 102_400,
        })
        expect(acquire).toHaveBeenCalledOnce()
        expect(harness.preflight).toHaveBeenCalledWith(TARGET_API, "act", undefined)
        expect(harness.commitMode).not.toHaveBeenCalled()
    })

    /** Cancel only the active awaiting-confirmation transaction. */
    it("cancels an awaiting confirmation", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.cancel("operation-1")

        expect(result).toEqual({ status: "rejected", operationId: "operation-1", error: "Mode switch cancelled." })
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
    })

    /** Compact before committing and release only after commit succeeds. */
    it("compacts then commits and releases", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.confirm("operation-1")

        expect(result).toEqual({ status: "switched", operationId: "operation-1" })
        expect(harness.compact).toHaveBeenCalledWith({
            trigger: "mode_switch",
            operationId: "operation-1",
            targetApi: TARGET_API,
            targetMode: "act",
            chatContent: undefined,
            transition: expect.objectContaining({
                kind: "mode_switch",
                source: { mode: "plan", profile: "large", contextWindow: 272_000 },
                target: { mode: "act", profile: "small", contextWindow: 128_000 },
            }),
        })
        expect(harness.commitMode).toHaveBeenCalledOnce()
        expect(harness.release).toHaveBeenCalledWith("operation-1")
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
    })

    /** Preserve source mode and expose a retryable failure when compaction fails. */
    it("does not commit after compact failure", async () => {
        harness.compact.mockResolvedValueOnce("failed")
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.confirm("operation-1")

        expect(result.status).toBe("rejected")
        expect(harness.commitMode).not.toHaveBeenCalled()
        expect(harness.coordinator.getSnapshot()).toMatchObject({ phase: "failed", operationId: "operation-1" })
    })

    /** Preserve source mode when the compaction hook cancels the operation. */
    it("does not commit after compact cancellation", async () => {
        harness.compact.mockResolvedValueOnce("cancelled")
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.confirm("operation-1")

        expect(result.status).toBe("rejected")
        expect(harness.commitMode).not.toHaveBeenCalled()
        expect(harness.coordinator.getSnapshot()).toMatchObject({ phase: "failed" })
    })

    /** Reject confirmation from an older dialog without mutating active state. */
    it("rejects a stale confirm operation id", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.confirm("stale-operation")

        expect(result.status).toBe("rejected")
        expect(harness.compact).not.toHaveBeenCalled()
        expect(harness.coordinator.getSnapshot().phase).toBe("awaiting_confirmation")
    })

    /** Reject cancellation from an older dialog without mutating active state. */
    it("rejects a stale cancel operation id", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.cancel("stale-operation")

        expect(result.status).toBe("rejected")
        expect(harness.coordinator.getSnapshot().phase).toBe("awaiting_confirmation")
    })

    /** Hold the shared transition lease before asynchronous target preflight completes. */
    it("rejects re-entry while target preflight is unresolved", async () => {
        let resolvePreflight: ((tokens: number) => void) | undefined
        harness.preflight.mockReturnValueOnce(
            new Promise<number>((resolve) => {
                resolvePreflight = resolve
            }),
        )
        const first = harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        await Promise.resolve()

        expect(harness.coordinator.getSnapshot()).toMatchObject({
            phase: "preflighting",
            operationId: "operation-1",
            taskId: "task-1",
        })
        const second = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(second).toEqual({ status: "in_progress", operationId: "operation-1" })
        resolvePreflight?.(117_499)
        await expect(first).resolves.toMatchObject({ status: "switched" })
    })

    /** Reject a Mode request while a Profile transition owns the shared lease. */
    it("rejects requests while a Profile transition owns the shared lease", async () => {
        harness.lease.acquire({ kind: "profile", operationId: "profile-operation-1", taskId: "task-1" })

        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result).toEqual({ status: "in_progress", operationId: "profile-operation-1" })
        expect(harness.preflight).not.toHaveBeenCalled()
    })

    /** Preserve an already-active shared transition even when the requested split modes use the same Profile. */
    it("does not bypass an existing shared lease for the same profile", async () => {
        const sharedProfile: ModeProfileResolver = {
            getSource: () => ({ ...SOURCE, profile: "shared" }),
            resolve: (mode) => ({ ...SOURCE, mode, profile: "shared", executionApi: TARGET_API }),
        }
        harness.coordinator = new ModeSwitchCoordinator({
            profiles: sharedProfile,
            pressure: harness.pressure,
            compaction: harness.compaction,
            commit: harness.commit,
            lease: harness.lease,
            postState: harness.postState,
            createId: () => "operation-1",
            getTaskId: () => "task-1",
        })
        harness.lease.acquire({ kind: "profile", operationId: "profile-operation-1", taskId: "task-1" })

        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result).toEqual({ status: "in_progress", operationId: "profile-operation-1" })
        expect(harness.preflight).not.toHaveBeenCalled()
        expect(harness.commitMode).not.toHaveBeenCalled()
    })

    /** Reject a second request until the active transaction reaches a terminal state. */
    it("rejects re-entry while confirmation is pending", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result).toEqual({ status: "in_progress", operationId: "operation-1" })
    })

    /** Reject requests that do not match the current task identity. */
    it("rejects a request for a stale task", async () => {
        const result = await harness.coordinator.request({ taskId: "task-2", targetMode: "act" })

        expect(result.status).toBe("rejected")
        expect(harness.commitMode).not.toHaveBeenCalled()
    })

    /** Stop before compaction when task identity changes after confirmation was shown. */
    it("rejects confirm after task change", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        harness.setTaskId("task-2")
        const result = await harness.coordinator.confirm("operation-1")

        expect(result.status).toBe("rejected")
        expect(harness.compact).not.toHaveBeenCalled()
        expect(harness.coordinator.getSnapshot().phase).toBe("failed")
    })

    /** Revalidate source state before compaction starts. */
    it("rejects confirm after source validation fails", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        harness.validate.mockReturnValueOnce(false)
        const result = await harness.coordinator.confirm("operation-1")

        expect(result.status).toBe("rejected")
        expect(harness.compact).not.toHaveBeenCalled()
    })

    /** Preserve a completed compaction card when the later Mode commit fails. */
    it("reports partial success without aborting completed compaction after commit failure", async () => {
        harness.commitMode.mockRejectedValueOnce(new Error("commit failed"))
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        const result = await harness.coordinator.confirm("operation-1")

        expect(result).toEqual({
            status: "rejected",
            operationId: "operation-1",
            error: "Context compaction completed, but the Mode transition commit failed: commit failed",
        })
        expect(harness.fail).not.toHaveBeenCalled()
        expect(harness.release).toHaveBeenCalledWith("operation-1")
        expect(harness.coordinator.getSnapshot()).toMatchObject({
            phase: "failed",
            error: "Context compaction completed, but the Mode transition commit failed: commit failed",
        })
    })

    /** Clear a failed transaction when a fresh request is made. */
    it("allows a new request after failure", async () => {
        harness.compact.mockResolvedValueOnce("failed")
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        await harness.coordinator.confirm("operation-1")
        harness.compact.mockResolvedValueOnce("completed")

        const result = await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })

        expect(result.status).toBe("confirmation_required")
        expect(harness.coordinator.getSnapshot().phase).toBe("awaiting_confirmation")
    })

    /** Reset active state and release task resources during lifecycle cleanup. */
    it("resets an active operation", async () => {
        await harness.coordinator.request({ taskId: "task-1", targetMode: "act" })
        await harness.coordinator.reset()

        expect(harness.fail).toHaveBeenCalledWith("operation-1", "Mode switch reset.")
        expect(harness.release).toHaveBeenCalledWith("operation-1")
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
    })
})
