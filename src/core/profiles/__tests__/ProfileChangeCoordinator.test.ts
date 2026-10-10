import type { ApiProfile } from "@shared/proto/dline/profile"
import { expect } from "chai"
import { describe, it, vi } from "vitest"
import type { Controller } from "@/core/controller"
import { ProfileChangeCoordinator } from "../ProfileChangeCoordinator"

interface ProfileBindingFixture {
    planModeProfile: string
    actModeProfile: string
    planModeProfileId?: string
    actModeProfileId?: string
}

/** Build a controller fixture bound to the supplied plan and act profiles. */
function createController(planProfile: string, actProfile: string, profileId?: string): Controller {
    const postStateToWebview = vi.fn().mockResolvedValue(undefined)
    return {
        task: {
            owners: {
                settings: {
                    planModeProfile: planProfile,
                    actModeProfile: actProfile,
                    planModeProfileId: profileId,
                    actModeProfileId: profileId,
                    mode: "act",
                    adoptProfileIdentity: vi.fn(function (
                        this: ProfileBindingFixture,
                        mode: "plan" | "act",
                        id: string,
                        name: string,
                    ) {
                        if (mode === "plan") {
                            this.planModeProfileId = id
                            this.planModeProfile = name
                        } else {
                            this.actModeProfileId = id
                            this.actModeProfile = name
                        }
                    }),
                },
                api: { rebuild: vi.fn() },
                prompt: { flush: vi.fn(async () => postStateToWebview()) },
            },
        },
        stateManager: {
            getGlobalSettingsKey: vi.fn((key: string) => {
                if (key === "planModeProfile") return planProfile
                if (key === "actModeProfile") return actProfile
                if (key === "planModeProfileId" || key === "actModeProfileId") return profileId
                return undefined
            }),
            getCanonicalSettingsKey: vi.fn((key: string) => {
                if (key === "planModeProfile") return planProfile
                if (key === "actModeProfile") return actProfile
                if (key === "planModeProfileId" || key === "actModeProfileId") return profileId
                return undefined
            }),
            setGlobalState: vi.fn(),
            flushPendingState: vi.fn().mockResolvedValue(undefined),
        },
        restartAccountUsagePolling: vi.fn(),
        postStateToWebview,
    } as unknown as Controller
}

/** Read the api-handler rebuild calls recorded by one controller fixture. */
function rebuildCalls(controller: Controller): unknown[][] {
    return (controller.task?.owners.api.rebuild as ReturnType<typeof vi.fn>).mock.calls
}

/** Read the prompt freshness flush calls recorded by one controller fixture. */
function flushCalls(controller: Controller): unknown[][] {
    return (controller.task?.owners.prompt.flush as ReturnType<typeof vi.fn>).mock.calls
}

/** Verify catalog commits refresh views and rebuild only the handler whose active Profile changed. */
describe("ProfileChangeCoordinator", () => {
    it("rebuilds only handlers whose active-mode Profile was edited", async () => {
        const first = createController("shared-profile", "shared-profile")
        const second = createController("other-profile", "shared-profile")
        const third = createController("other-profile", "other-profile")
        const coordinator = new ProfileChangeCoordinator(() => [first, second, third])
        const oldProfiles = [{ id: "shared-id", name: "shared-profile", modelId: "old-model" }] as ApiProfile[]
        const nextProfiles = [{ id: "shared-id", name: "shared-profile", modelId: "new-model" }] as ApiProfile[]

        await coordinator.publish(oldProfiles, nextProfiles)

        // Each fixture runs in Act mode, so only an Act binding to the edited Profile rebuilds.
        expect(rebuildCalls(first)).to.deep.equal([[]])
        expect(rebuildCalls(second)).to.deep.equal([[]])
        expect(rebuildCalls(third)).to.have.length(0)
        for (const controller of [first, second, third]) {
            expect(flushCalls(controller)).to.deep.equal([["profile_catalog"]])
            expect((controller.restartAccountUsagePolling as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
            expect((controller.postStateToWebview as ReturnType<typeof vi.fn>).mock.calls).to.have.length(1)
        }
        expect(coordinator.revision).to.equal(1)
    })

    it("rebuilds the active handler before prompt freshness is reevaluated", async () => {
        const controller = createController("shared-profile", "shared-profile", "shared-id")
        const order: string[] = []
        ;(controller.task!.owners.api.rebuild as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            order.push("rebuild")
        })
        ;(controller.task!.owners.prompt.flush as ReturnType<typeof vi.fn>).mockImplementation(async (source: string) => {
            order.push(`flush:${source}`)
        })
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const before = [
            {
                id: "shared-id",
                name: "shared-profile",
                provider: "anthropic",
                anthropic: { claudeCodeIdentity: { enabled: false } },
            },
        ] as unknown as ApiProfile[]
        const after = [
            {
                id: "shared-id",
                name: "shared-profile",
                provider: "anthropic",
                anthropic: { claudeCodeIdentity: { enabled: true } },
            },
        ] as unknown as ApiProfile[]

        await coordinator.publish(before, after)

        expect(order).to.deep.equal(["rebuild", "flush:profile_catalog"])
    })

    it("does not rebuild for an edit to the inactive mode's Profile or a disabled Profile", async () => {
        const inactive = createController("plan-profile", "act-profile")
        const disabled = createController("act-profile", "act-profile")
        const coordinator = new ProfileChangeCoordinator(() => [inactive])
        await coordinator.publish(
            [{ id: "plan-id", name: "plan-profile", modelId: "old" }] as ApiProfile[],
            [{ id: "plan-id", name: "plan-profile", modelId: "new" }] as ApiProfile[],
        )
        expect(rebuildCalls(inactive)).to.have.length(0)
        expect(flushCalls(inactive)).to.deep.equal([["profile_catalog"]])

        const disabling = new ProfileChangeCoordinator(() => [disabled])
        await disabling.publish(
            [{ id: "act-id", name: "act-profile", enabled: true }] as ApiProfile[],
            [{ id: "act-id", name: "act-profile", enabled: false }] as ApiProfile[],
        )
        expect(rebuildCalls(disabled)).to.have.length(0)
    })

    it("keeps publishing prompt freshness when the handler rebuild fails", async () => {
        const controller = createController("shared-profile", "shared-profile", "shared-id")
        ;(controller.task!.owners.api.rebuild as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("missing key"))
        const coordinator = new ProfileChangeCoordinator(() => [controller])

        await coordinator.publish(
            [{ id: "shared-id", name: "shared-profile", modelId: "old" }] as ApiProfile[],
            [{ id: "shared-id", name: "shared-profile", modelId: "new" }] as ApiProfile[],
        )

        expect(flushCalls(controller)).to.deep.equal([["profile_catalog"]])
    })

    it("broadcasts a pure reorder even when no profile fields change", async () => {
        const controller = createController("first-profile", "first-profile", "first-id")
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const first = { id: "first-id", name: "first-profile", provider: "openai" } as ApiProfile
        const second = { id: "second-id", name: "second-profile", provider: "anthropic" } as ApiProfile

        await coordinator.publish([first, second], [second, first])

        expect(flushCalls(controller)).to.deep.equal([["profile_catalog"]])
        expect((controller.postStateToWebview as ReturnType<typeof vi.fn>).mock.calls).to.have.length(1)
        expect((controller.stateManager.setGlobalState as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
        expect(coordinator.revision).to.equal(1)
    })

    it("does not broadcast an unchanged Catalog", async () => {
        const controller = createController("profile", "profile", "profile-id")
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const profiles = [{ id: "profile-id", name: "profile", provider: "openai" }] as ApiProfile[]

        await coordinator.publish(profiles, structuredClone(profiles))

        expect(flushCalls(controller)).to.have.length(0)
        expect((controller.postStateToWebview as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
        expect(coordinator.revision).to.equal(0)
    })

    it("adopts a renamed display name without rebuilding the current handler", async () => {
        const controller = createController("old-profile", "old-profile", "profile-id")
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const oldProfiles = [{ id: "profile-id", name: "old-profile", provider: "openai" }] as ApiProfile[]
        const nextProfiles = [{ id: "profile-id", name: "renamed-profile", provider: "openai" }] as ApiProfile[]

        await coordinator.publish(oldProfiles, nextProfiles)

        expect(controller.task?.owners.settings.planModeProfile).to.equal("renamed-profile")
        expect(controller.task?.owners.settings.actModeProfile).to.equal("renamed-profile")
        expect(rebuildCalls(controller)).to.have.length(0)
    })

    it("adopts a rename by stable id when the legacy task name is stale", async () => {
        const controller = createController("stale-plan-name", "stale-act-name", "profile-id")
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const oldProfiles = [{ id: "profile-id", name: "old-profile", provider: "openai" }] as ApiProfile[]
        const nextProfiles = [{ id: "profile-id", name: "renamed-profile", provider: "openai" }] as ApiProfile[]

        await coordinator.publish(oldProfiles, nextProfiles)

        expect(controller.task?.owners.settings.planModeProfile).to.equal("renamed-profile")
        expect(controller.task?.owners.settings.actModeProfile).to.equal("renamed-profile")
        expect(rebuildCalls(controller)).to.have.length(0)
    })

    it("reads canonical global bindings instead of promoting an active Task override", async () => {
        const controller = createController("task-profile", "task-profile", "task-profile-id")
        ;(controller.stateManager.getCanonicalSettingsKey as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
            if (key === "planModeProfile" || key === "actModeProfile") return "global-profile"
            if (key === "planModeProfileId" || key === "actModeProfileId") return "global-profile-id"
            return undefined
        })
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const oldProfiles = [{ id: "task-profile-id", name: "task-profile", provider: "openai" }] as ApiProfile[]
        const nextProfiles = [{ id: "task-profile-id", name: "renamed-task-profile", provider: "openai" }] as ApiProfile[]

        await coordinator.publish(oldProfiles, nextProfiles)

        expect(controller.task?.owners.settings.planModeProfile).to.equal("renamed-task-profile")
        expect(controller.task?.owners.settings.actModeProfile).to.equal("renamed-task-profile")
        expect((controller.stateManager.setGlobalState as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
    })

    it("treats post-commit Task freshness publication as best-effort", async () => {
        const controller = createController("profile", "profile", "profile-id")
        ;(controller.task?.owners.prompt.flush as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("publish failed"))
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const oldProfiles = [{ id: "profile-id", name: "profile", modelId: "old-model" }] as ApiProfile[]
        const nextProfiles = [{ id: "profile-id", name: "profile", modelId: "new-model" }] as ApiProfile[]

        await coordinator.publish(oldProfiles, nextProfiles)

        expect(coordinator.revision).to.equal(1)
        // The active Profile's model changed, so the handler was rebuilt before the failed publication.
        expect(rebuildCalls(controller)).to.have.length(1)
    })

    it("keeps deleted profile bindings unchanged instead of selecting a fallback", async () => {
        const controller = createController("deleted-profile", "deleted-profile", "deleted-id")
        const coordinator = new ProfileChangeCoordinator(() => [controller])
        const oldProfiles = [{ id: "deleted-id", name: "deleted-profile", provider: "openai" }] as ApiProfile[]
        const nextProfiles = [
            { id: "fallback-id", name: "fallback-profile", provider: "openai", enabled: true, usedFor: ["plan", "act"] },
        ] as ApiProfile[]

        await coordinator.publish(oldProfiles, nextProfiles)

        expect(controller.task?.owners.settings.planModeProfile).to.equal("deleted-profile")
        expect(controller.task?.owners.settings.actModeProfile).to.equal("deleted-profile")
        expect(rebuildCalls(controller)).to.have.length(0)
    })
})
