import type { ApiHandler } from "@core/api"
import { ContextTransitionLease } from "@core/controller/context-transition/ContextTransitionLease"
import type { Mode } from "@shared/storage/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProfileSwitchCoordinator } from "../ProfileSwitchCoordinator"
import type { ProfileBindingResolver, ProfileCommitPort, ProfileSwitchOperation, ResolvedProfileTarget } from "../types"

interface TestHarness {
    coordinator: ProfileSwitchCoordinator
    lease: ContextTransitionLease
    getOccupiedTokens: ReturnType<typeof vi.fn<() => number>>
    validate: ReturnType<typeof vi.fn<(operation: ProfileSwitchOperation) => boolean>>
    commitProfile: ReturnType<typeof vi.fn<ProfileCommitPort["commit"]>>
    resolveTarget: ReturnType<
        typeof vi.fn<(profileId: string, profileName: string, mode: Mode) => ResolvedProfileTarget | undefined>
    >
    setTaskId: (taskId: string | undefined) => void
}

const TARGET_API = { getModel: vi.fn() } as unknown as ApiHandler
const SOURCE_BINDINGS: Record<Mode, string> = { plan: "plan-source", act: "act-source" }
const TARGET_CONTEXT_WINDOW = 128_000

const SWITCH_REQUEST = {
    taskId: "task-1",
    targetProfileId: "target-id",
    targetProfile: "target-profile",
    targetModes: ["act"] as Mode[],
}

/** Build deterministic ports for one Profile transaction. */
function createHarness(
    options: { occupiedTokens?: number; currentMode?: Mode; lease?: ContextTransitionLease } = {},
): TestHarness {
    let taskId: string | undefined = "task-1"
    const currentMode = options.currentMode ?? "act"
    const lease = options.lease ?? new ContextTransitionLease()
    const resolveTarget = vi.fn<(profileId: string, profileName: string, mode: Mode) => ResolvedProfileTarget | undefined>(
        (profileId, profileName, mode) => ({
            profileId,
            profile: profileName,
            mode,
            contextWindow: TARGET_CONTEXT_WINDOW,
            triggerTokens: 117_500,
            fittingExitTarget: 102_400,
            executionApi: TARGET_API,
        }),
    )
    const bindings: ProfileBindingResolver = {
        getCurrentMode: () => currentMode,
        getBinding: (mode) => SOURCE_BINDINGS[mode],
        resolveTarget,
    }
    const getOccupiedTokens = vi.fn<() => number>(() => options.occupiedTokens ?? TARGET_CONTEXT_WINDOW)
    const validate = vi.fn<(operation: ProfileSwitchOperation) => boolean>(() => true)
    const commitProfile = vi.fn<ProfileCommitPort["commit"]>(async () => undefined)
    const commit: ProfileCommitPort = { validate, commit: commitProfile }
    const coordinator = new ProfileSwitchCoordinator({
        bindings,
        occupied: { getOccupiedTokens },
        commit,
        lease,
        postState: vi.fn(async () => undefined),
        createId: () => "profile-operation-1",
        getTaskId: () => taskId,
    })

    return {
        coordinator,
        lease,
        getOccupiedTokens,
        validate,
        commitProfile,
        resolveTarget,
        setTaskId: (nextTaskId) => {
            taskId = nextTaskId
        },
    }
}

/** Verify that selecting a Profile only rebinds handlers behind at most one advisory notice. */
describe("ProfileSwitchCoordinator", () => {
    let harness: TestHarness

    beforeEach(() => {
        harness = createHarness({ occupiedTokens: TARGET_CONTEXT_WINDOW - 1 })
    })

    it("switches directly when the occupied context fits the target window", async () => {
        const result = await harness.coordinator.request(SWITCH_REQUEST)

        expect(result).toEqual({ status: "switched", operationId: "profile-operation-1" })
        expect(harness.commitProfile).toHaveBeenCalledOnce()
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
        expect(harness.lease.getActive()).toBeUndefined()
    })

    it("skips the window check when only an inactive binding changes", async () => {
        const result = await harness.coordinator.request({ ...SWITCH_REQUEST, targetModes: ["plan"] })

        expect(result.status).toBe("switched")
        expect(harness.resolveTarget).not.toHaveBeenCalled()
        expect(harness.getOccupiedTokens).not.toHaveBeenCalled()
        expect(harness.commitProfile.mock.calls[0]?.[0].targetModes).toEqual(["plan"])
    })

    it("retains both bindings for one unified atomic commit", async () => {
        await harness.coordinator.request({ ...SWITCH_REQUEST, targetModes: ["plan", "act"] })

        expect(harness.getOccupiedTokens).toHaveBeenCalledOnce()
        expect(harness.commitProfile.mock.calls[0]?.[0].targetModes).toEqual(["plan", "act"])
    })

    it("asks for confirmation when the occupied context does not fit the target window", async () => {
        harness = createHarness({ occupiedTokens: TARGET_CONTEXT_WINDOW })

        const result = await harness.coordinator.request(SWITCH_REQUEST)

        expect(result).toEqual({ status: "confirmation_required", operationId: "profile-operation-1" })
        expect(harness.commitProfile).not.toHaveBeenCalled()
        expect(harness.coordinator.getSnapshot()).toMatchObject({
            phase: "awaiting_confirmation",
            operationId: "profile-operation-1",
            sourceProfile: "act-source",
            targetProfile: "target-profile",
            activeMode: "act",
            currentTokens: TARGET_CONTEXT_WINDOW,
            targetContextWindow: TARGET_CONTEXT_WINDOW,
        })
    })

    it("adopts the target bindings on confirmation without compacting", async () => {
        harness = createHarness({ occupiedTokens: TARGET_CONTEXT_WINDOW })
        await harness.coordinator.request(SWITCH_REQUEST)

        const result = await harness.coordinator.confirm("profile-operation-1")

        expect(result).toEqual({ status: "switched", operationId: "profile-operation-1" })
        expect(harness.commitProfile).toHaveBeenCalledOnce()
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
        expect(harness.lease.getActive()).toBeUndefined()
    })

    it("cancels without adopting the target binding", async () => {
        harness = createHarness({ occupiedTokens: TARGET_CONTEXT_WINDOW })
        await harness.coordinator.request(SWITCH_REQUEST)

        const result = await harness.coordinator.cancel("profile-operation-1")

        expect(result.status).toBe("rejected")
        expect(harness.commitProfile).not.toHaveBeenCalled()
        expect(harness.coordinator.getSnapshot()).toEqual({ phase: "idle" })
        expect(harness.lease.getActive()).toBeUndefined()
    })

    it("switches directly when the target handler cannot be resolved", async () => {
        harness.resolveTarget.mockReturnValueOnce(undefined)

        const result = await harness.coordinator.request(SWITCH_REQUEST)

        expect(result.status).toBe("switched")
        expect(harness.commitProfile).toHaveBeenCalledOnce()
    })

    it("switches directly when the target context window is unknown", async () => {
        harness.resolveTarget.mockReturnValueOnce({
            profileId: "target-id",
            profile: "target-profile",
            mode: "act",
            contextWindow: 0,
            triggerTokens: 0,
            fittingExitTarget: 0,
            executionApi: TARGET_API,
        })

        const result = await harness.coordinator.request(SWITCH_REQUEST)

        expect(result.status).toBe("switched")
        expect(harness.commitProfile).toHaveBeenCalledOnce()
    })

    it("reports a failed adoption instead of silently returning to idle", async () => {
        harness.commitProfile.mockRejectedValueOnce(new Error("adoption failed"))

        await expect(harness.coordinator.request(SWITCH_REQUEST)).resolves.toMatchObject({
            status: "rejected",
            error: "adoption failed",
        })
        expect(harness.coordinator.getSnapshot()).toMatchObject({ phase: "failed", error: "adoption failed" })
        expect(harness.lease.getActive()).toBeUndefined()
    })

    it("publishes a rejected request as a visible failure", async () => {
        harness.setTaskId("task-2")

        const result = await harness.coordinator.request(SWITCH_REQUEST)

        expect(result.status).toBe("rejected")
        expect(harness.coordinator.getSnapshot()).toMatchObject({
            phase: "failed",
            error: "Active task changed before Profile switch request.",
        })
        expect(harness.lease.getActive()).toBeUndefined()
    })

    it("rejects Profile requests while a Mode transition owns the shared lease", async () => {
        harness.lease.acquire({ kind: "mode", operationId: "mode-operation-1", taskId: "task-1" })

        const result = await harness.coordinator.request(SWITCH_REQUEST)

        expect(result).toEqual({ status: "in_progress", operationId: "mode-operation-1" })
        expect(harness.getOccupiedTokens).not.toHaveBeenCalled()
    })

    it("rejects stale confirmation after the active task changes", async () => {
        harness = createHarness({ occupiedTokens: TARGET_CONTEXT_WINDOW })
        await harness.coordinator.request(SWITCH_REQUEST)
        harness.setTaskId("task-2")

        const result = await harness.coordinator.confirm("profile-operation-1")

        expect(result.status).toBe("rejected")
        expect(harness.commitProfile).not.toHaveBeenCalled()
        expect(harness.lease.getActive()).toBeUndefined()
    })
})
