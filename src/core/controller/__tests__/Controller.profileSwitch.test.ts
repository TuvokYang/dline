import type { ApiHandler } from "@core/api"
import { Controller } from "@core/controller"
import { ContextTransitionEngine } from "@core/controller/context-transition/ContextTransitionEngine"
import { ContextTransitionLease } from "@core/controller/context-transition/ContextTransitionLease"
import * as profileCatalog from "@core/controller/file/getApiProfiles"
import type { ProfileSwitchCoordinator } from "@core/controller/profile-switch/ProfileSwitchCoordinator"
import { controllerTransitionDraftCarrier } from "@core/controller/task/replyWithTransitionDraft"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { beforeEach, describe, expect, it, vi } from "vitest"

/** Verify the production Profile transition factory preserves the pending draft across preflight and compaction. */
describe("Controller Profile switch integration", () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it("durably commits stable global Profile identity when no Task is active", async () => {
        vi.spyOn(profileCatalog, "readApiProfiles").mockReturnValue([
            { id: "target-id", name: "target-profile", enabled: true } as never,
        ])
        const setGlobalStateBatch = vi.fn()
        const flushPendingState = vi.fn(async () => undefined)
        const request = vi.fn()
        const postStateToWebview = vi.fn(async () => undefined)
        const restartAccountUsagePolling = vi.fn()
        const fakeController = {
            task: undefined,
            stateManager: {
                setGlobalStateBatch,
                flushPendingState,
            },
            profileSwitchCoordinator: { request },
            postStateToWebview,
            restartAccountUsagePolling,
        }

        const result = await Controller.prototype.requestProfileSwitch.call(fakeController, "target-id", ["plan", "act"])

        expect(result.status).toBe("switched")
        expect(setGlobalStateBatch).toHaveBeenCalledWith({
            planModeProfileId: "target-id",
            planModeProfile: "target-profile",
            actModeProfileId: "target-id",
            actModeProfile: "target-profile",
        })
        expect(flushPendingState).toHaveBeenCalledOnce()
        expect(restartAccountUsagePolling).toHaveBeenCalledOnce()
        expect(postStateToWebview).toHaveBeenCalledWith({ immediate: true })
        expect(request).not.toHaveBeenCalled()
    })
    it("confirms against the occupied context window and adopts the target without compacting", async () => {
        const targetApi = { getModel: vi.fn() } as unknown as ApiHandler
        const draft = { message: "keep this draft", images: ["image"], files: ["file"] }
        const getOccupiedContextTokens = vi.fn(() => 128_001)
        const compact = vi.fn(async () => "completed" as const)
        const release = vi.fn()
        const setProfileIdentityBindings = vi.fn()
        const rebuild = vi.fn(async () => undefined)
        const dismissProviderFailure = vi.fn(async () => undefined)
        const handBack = vi.fn(() => true)
        const flushPendingState = vi.fn(async () => undefined)
        const restartAccountUsagePolling = vi.fn()
        const task = createSessionFixture({
            taskId: "task-1",
            owners: {
                settings: { mode: "act" as const, setProfileIdentityBindings },
                api: { rebuild },
                interactions: { dismissProviderFailure },
                providerRetry: { handBack },
            },
        })
        const fakeController = {
            stateManager: { flushPendingState },
            task,
            // Occupancy is read by the Controller from the live indicator.
            getOccupiedContextTokens,
            profileTransitionEngine: new ContextTransitionEngine({
                lease: new ContextTransitionLease(),
                compaction: {
                    compact,
                    complete: release,
                    abort: vi.fn(async () => undefined),
                },
                postState: vi.fn(async () => undefined),
                createId: () => "profile-operation-1",
                // The carrier the Controller wires reads only its current task.
                draftCarrier: controllerTransitionDraftCarrier({ task } as never),
            }),
            resolveTaskProfileName: vi.fn(() => "source-profile"),
            resolveProfileTarget: vi.fn(() => ({
                profileId: "target-id",
                profile: "target-profile",
                mode: "act" as const,
                contextWindow: 128_000,
                triggerTokens: 117_500,
                fittingExitTarget: 102_400,
                executionApi: targetApi,
            })),
            validateProfileSwitch: vi.fn(() => true),
            postStateToWebview: vi.fn(async () => undefined),
            restartAccountUsagePolling,
        }
        const createProfileSwitchCoordinator = Reflect.get(Controller.prototype, "createProfileSwitchCoordinator") as (
            this: typeof fakeController,
        ) => ProfileSwitchCoordinator
        const coordinator = createProfileSwitchCoordinator.call(fakeController)

        const request = await coordinator.request({
            taskId: "task-1",
            targetProfileId: "target-id",
            targetProfile: "target-profile",
            targetModes: ["act"],
            chatContent: draft,
        })

        expect(request).toEqual({ status: "confirmation_required", operationId: "profile-operation-1" })
        expect(getOccupiedContextTokens).toHaveBeenCalledOnce()

        await expect(coordinator.confirm("profile-operation-1")).resolves.toEqual({
            status: "switched",
            operationId: "profile-operation-1",
            // No dialog awaits a reply, so the draft stays the composer's.
            draftDelivered: false,
        })
        expect(compact).not.toHaveBeenCalled()
        expect(release).not.toHaveBeenCalled()
        // Adopting a Profile also drops the previous Profile's runtime overrides.
        expect(setProfileIdentityBindings).toHaveBeenCalledWith(
            { act: { profileId: "target-id", profileName: "target-profile" } },
            { clearRuntimeOverrides: true },
        )
        expect(rebuild).toHaveBeenCalledWith({ abortPrevious: true })
        // The switch is reported only once the binding is on disk.
        expect(flushPendingState).toHaveBeenCalledOnce()
        // The source Profile's retry countdown is handed back once the target is bound.
        expect(handBack).toHaveBeenCalledOnce()
        expect(rebuild.mock.invocationCallOrder[0]).toBeLessThan(handBack.mock.invocationCallOrder[0])
        expect(dismissProviderFailure).toHaveBeenCalledOnce()
        expect(restartAccountUsagePolling).toHaveBeenCalledOnce()
    })

    it("switches Profiles while a Mode transition still owns its own transaction", async () => {
        const setProfileIdentityBindings = vi.fn()
        const rebuild = vi.fn(async () => undefined)
        const flushPendingState = vi.fn(async () => undefined)
        const restartAccountUsagePolling = vi.fn()
        const fakeController = {
            stateManager: { flushPendingState },
            task: createSessionFixture({
                taskId: "task-1",
                owners: {
                    settings: { mode: "act" as const, setProfileIdentityBindings },
                    api: { rebuild },
                },
            }),
            getOccupiedContextTokens: () => 0,
            resolveTaskProfileName: vi.fn(() => "source-profile"),
            // An unresolved target degrades to a direct switch, which is exactly the
            // path that must stay reachable while another transition is in flight.
            resolveProfileTarget: vi.fn(() => undefined),
            validateProfileSwitch: vi.fn(() => true),
            validateModeSwitch: vi.fn(() => true),
            resolveModeProfile: vi.fn(() => undefined),
            postStateToWebview: vi.fn(async () => undefined),
            restartAccountUsagePolling,
        }

        const createContextTransitionEngine = Reflect.get(Controller.prototype, "createContextTransitionEngine") as (
            this: typeof fakeController,
        ) => ContextTransitionEngine
        const createProfileSwitchCoordinator = Reflect.get(Controller.prototype, "createProfileSwitchCoordinator") as (
            this: typeof fakeController,
        ) => ProfileSwitchCoordinator

        const modeEngine = createContextTransitionEngine.call(fakeController)
        const profileEngine = createContextTransitionEngine.call(fakeController)
        Object.assign(fakeController, {
            contextTransitionEngine: modeEngine,
            profileTransitionEngine: profileEngine,
        })
        const coordinator = createProfileSwitchCoordinator.call(fakeController)

        // Occupy the Mode transaction the way an unanswered confirmation would.
        const modeDeps = Reflect.get(modeEngine, "deps") as { lease: ContextTransitionLease }
        expect(modeDeps.lease.acquire({ kind: "mode", operationId: "mode-operation-1", taskId: "task-1" })).toBe(true)

        const result = await coordinator.request({
            taskId: "task-1",
            targetProfileId: "target-id",
            targetProfile: "target-profile",
            targetModes: ["act"],
        })

        expect(result.status).toBe("switched")
        expect(setProfileIdentityBindings).toHaveBeenCalledWith(
            { act: { profileId: "target-id", profileName: "target-profile" } },
            { clearRuntimeOverrides: true },
        )
        expect(flushPendingState).toHaveBeenCalledOnce()
        expect(restartAccountUsagePolling).toHaveBeenCalledOnce()
    })

    it("restores the previous bindings and handler when the switch cannot be persisted", async () => {
        const previous = { plan: { profileId: "source-id", profileName: "source-profile" } }
        const setProfileIdentityBindings = vi.fn(() => previous)
        const restoreProfileState = vi.fn()
        const rebuild = vi.fn(async () => undefined)
        const handBack = vi.fn(() => true)
        const flushPendingState = vi.fn(async () => {
            throw new Error("disk full")
        })
        const fakeController = {
            stateManager: { flushPendingState },
            task: createSessionFixture({
                taskId: "task-1",
                owners: {
                    settings: { mode: "act" as const, setProfileIdentityBindings, restoreProfileState },
                    api: { rebuild },
                    providerRetry: { handBack },
                },
            }),
            getOccupiedContextTokens: () => 0,
            resolveTaskProfileName: vi.fn(() => "source-profile"),
            resolveProfileTarget: vi.fn(() => undefined),
            validateProfileSwitch: vi.fn(() => true),
            postStateToWebview: vi.fn(async () => undefined),
            restartAccountUsagePolling: vi.fn(),
        }
        const createContextTransitionEngine = Reflect.get(Controller.prototype, "createContextTransitionEngine") as (
            this: typeof fakeController,
        ) => ContextTransitionEngine
        const createProfileSwitchCoordinator = Reflect.get(Controller.prototype, "createProfileSwitchCoordinator") as (
            this: typeof fakeController,
        ) => ProfileSwitchCoordinator
        Object.assign(fakeController, { profileTransitionEngine: createContextTransitionEngine.call(fakeController) })
        const coordinator = createProfileSwitchCoordinator.call(fakeController)

        const result = await coordinator.request({
            taskId: "task-1",
            targetProfileId: "target-id",
            targetProfile: "target-profile",
            targetModes: ["act"],
        })

        expect(result.status).toBe("rejected")
        expect(restoreProfileState).toHaveBeenCalledWith(previous)
        // Rebuilt once for the target and once more back onto the restored bindings.
        expect(rebuild).toHaveBeenCalledTimes(2)
        // An uncommitted switch leaves the running retry countdown alone.
        expect(handBack).not.toHaveBeenCalled()
    })
})
