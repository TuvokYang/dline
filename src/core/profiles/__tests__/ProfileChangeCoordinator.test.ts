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
			taskSm: {
				planModeProfile: planProfile,
				actModeProfile: actProfile,
				planModeProfileId: profileId,
				actModeProfileId: profileId,
				mode: "act",
				setPlanModeProfile: vi.fn(function (this: ProfileBindingFixture, value: string) {
					this.planModeProfile = value
				}),
				setActModeProfile: vi.fn(function (this: ProfileBindingFixture, value: string) {
					this.actModeProfile = value
				}),
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
			rebuildApiHandler: vi.fn(),
			flushPromptFreshnessInvalidation: vi.fn(async () => postStateToWebview()),
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

/** Verify catalog commits refresh views without mutating active runtime handlers. */
describe("ProfileChangeCoordinator", () => {
	it("broadcasts ordinary profile edits without rebuilding active handlers", async () => {
		const first = createController("shared-profile", "shared-profile")
		const second = createController("other-profile", "shared-profile")
		const third = createController("other-profile", "other-profile")
		const coordinator = new ProfileChangeCoordinator(() => [first, second, third])
		const oldProfiles = [{ id: "shared-id", name: "shared-profile", modelId: "old-model" }] as ApiProfile[]
		const nextProfiles = [{ id: "shared-id", name: "shared-profile", modelId: "new-model" }] as ApiProfile[]

		await coordinator.publish(oldProfiles, nextProfiles)

		for (const controller of [first, second, third]) {
			expect((controller.task?.rebuildApiHandler as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
			expect((controller.task?.flushPromptFreshnessInvalidation as ReturnType<typeof vi.fn>).mock.calls).to.deep.equal([
				["profile_catalog"],
			])
			expect((controller.restartAccountUsagePolling as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
			expect((controller.postStateToWebview as ReturnType<typeof vi.fn>).mock.calls).to.have.length(1)
		}
		expect(coordinator.revision).to.equal(1)
	})

	it("broadcasts a pure reorder even when no profile fields change", async () => {
		const controller = createController("first-profile", "first-profile", "first-id")
		const coordinator = new ProfileChangeCoordinator(() => [controller])
		const first = { id: "first-id", name: "first-profile", provider: "openai" } as ApiProfile
		const second = { id: "second-id", name: "second-profile", provider: "anthropic" } as ApiProfile

		await coordinator.publish([first, second], [second, first])

		expect((controller.task?.flushPromptFreshnessInvalidation as ReturnType<typeof vi.fn>).mock.calls).to.deep.equal([
			["profile_catalog"],
		])
		expect((controller.postStateToWebview as ReturnType<typeof vi.fn>).mock.calls).to.have.length(1)
		expect((controller.stateManager.setGlobalState as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
		expect(coordinator.revision).to.equal(1)
	})

	it("does not broadcast an unchanged Catalog", async () => {
		const controller = createController("profile", "profile", "profile-id")
		const coordinator = new ProfileChangeCoordinator(() => [controller])
		const profiles = [{ id: "profile-id", name: "profile", provider: "openai" }] as ApiProfile[]

		await coordinator.publish(profiles, structuredClone(profiles))

		expect((controller.task?.flushPromptFreshnessInvalidation as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
		expect((controller.postStateToWebview as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
		expect(coordinator.revision).to.equal(0)
	})

	it("adopts a renamed display name without rebuilding the current handler", async () => {
		const controller = createController("old-profile", "old-profile", "profile-id")
		const coordinator = new ProfileChangeCoordinator(() => [controller])
		const oldProfiles = [{ id: "profile-id", name: "old-profile", provider: "openai" }] as ApiProfile[]
		const nextProfiles = [{ id: "profile-id", name: "renamed-profile", provider: "openai" }] as ApiProfile[]

		await coordinator.publish(oldProfiles, nextProfiles)

		expect(controller.task?.taskSm.planModeProfile).to.equal("renamed-profile")
		expect(controller.task?.taskSm.actModeProfile).to.equal("renamed-profile")
		expect((controller.task?.rebuildApiHandler as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
	})

	it("adopts a rename by stable id when the legacy task name is stale", async () => {
		const controller = createController("stale-plan-name", "stale-act-name", "profile-id")
		const coordinator = new ProfileChangeCoordinator(() => [controller])
		const oldProfiles = [{ id: "profile-id", name: "old-profile", provider: "openai" }] as ApiProfile[]
		const nextProfiles = [{ id: "profile-id", name: "renamed-profile", provider: "openai" }] as ApiProfile[]

		await coordinator.publish(oldProfiles, nextProfiles)

		expect(controller.task?.taskSm.planModeProfile).to.equal("renamed-profile")
		expect(controller.task?.taskSm.actModeProfile).to.equal("renamed-profile")
		expect((controller.task?.rebuildApiHandler as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
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

		expect(controller.task?.taskSm.planModeProfile).to.equal("renamed-task-profile")
		expect(controller.task?.taskSm.actModeProfile).to.equal("renamed-task-profile")
		expect((controller.stateManager.setGlobalState as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
	})

	it("treats post-commit Task freshness publication as best-effort", async () => {
		const controller = createController("profile", "profile", "profile-id")
		;(controller.task?.flushPromptFreshnessInvalidation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("publish failed"),
		)
		const coordinator = new ProfileChangeCoordinator(() => [controller])
		const oldProfiles = [{ id: "profile-id", name: "profile", modelId: "old-model" }] as ApiProfile[]
		const nextProfiles = [{ id: "profile-id", name: "profile", modelId: "new-model" }] as ApiProfile[]

		await coordinator.publish(oldProfiles, nextProfiles)

		expect(coordinator.revision).to.equal(1)
		expect((controller.task?.rebuildApiHandler as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
	})

	it("keeps deleted profile bindings unchanged instead of selecting a fallback", async () => {
		const controller = createController("deleted-profile", "deleted-profile", "deleted-id")
		const coordinator = new ProfileChangeCoordinator(() => [controller])
		const oldProfiles = [{ id: "deleted-id", name: "deleted-profile", provider: "openai" }] as ApiProfile[]
		const nextProfiles = [
			{ id: "fallback-id", name: "fallback-profile", provider: "openai", enabled: true, usedFor: ["plan", "act"] },
		] as ApiProfile[]

		await coordinator.publish(oldProfiles, nextProfiles)

		expect(controller.task?.taskSm.planModeProfile).to.equal("deleted-profile")
		expect(controller.task?.taskSm.actModeProfile).to.equal("deleted-profile")
		expect((controller.task?.rebuildApiHandler as ReturnType<typeof vi.fn>).mock.calls).to.have.length(0)
	})
})
