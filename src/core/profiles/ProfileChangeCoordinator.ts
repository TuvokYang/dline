import type { ApiProfile } from "@shared/proto/dline/profile"
import { Logger } from "@shared/services/Logger"
import type { Controller } from "@/core/controller"

interface ProfileChange {
	id: string
	oldProfile?: ApiProfile
	nextProfile?: ApiProfile
}

/** Coordinate process-wide profile update notifications across active controllers. */
export class ProfileChangeCoordinator {
	#revision = 0

	/** Create a coordinator backed by an active-controller snapshot provider. */
	constructor(private readonly getControllers: () => Controller[]) {}

	/** Return the latest process-local profile revision. */
	get revision(): number {
		return this.#revision
	}

	/**
	 * Publish profile changes after the new profile list has been persisted.
	 *
	 * @param oldProfiles Profiles read before the successful write.
	 * @param nextProfiles Profiles persisted by the successful write.
	 */
	async publish(oldProfiles: ApiProfile[], nextProfiles: ApiProfile[]): Promise<void> {
		const changes = this.buildChanges(oldProfiles, nextProfiles)
		if (changes.size === 0) {
			return
		}
		this.#revision += 1

		await Promise.all(this.getControllers().map((controller) => this.publishToController(controller, changes)))
	}

	private async publishToController(controller: Controller, changes: Map<string, ProfileChange>): Promise<void> {
		const task = controller.task
		try {
			if (task) {
				this.adoptTaskBinding(task.taskSm.planModeProfileId, task.taskSm.planModeProfile, "plan", changes, task.taskSm)
				this.adoptTaskBinding(task.taskSm.actModeProfileId, task.taskSm.actModeProfile, "act", changes, task.taskSm)
			}

			this.adoptGlobalBinding(
				controller,
				controller.stateManager.getCanonicalSettingsKey("planModeProfileId"),
				controller.stateManager.getCanonicalSettingsKey("planModeProfile"),
				"plan",
				changes,
			)
			this.adoptGlobalBinding(
				controller,
				controller.stateManager.getCanonicalSettingsKey("actModeProfileId"),
				controller.stateManager.getCanonicalSettingsKey("actModeProfile"),
				"act",
				changes,
			)

			// Rename adoption updates compatibility names only. Persist those
			// bindings before publishing the committed Catalog revision.
			await controller.stateManager.flushPendingState()

			// Catalog edits must not replace a running handler. They can still
			// change prompt-visible image tool availability for the bound Profile.
			if (task) {
				await task.flushPromptFreshnessInvalidation("profile_catalog")
			} else {
				await controller.postStateToWebview()
			}
		} catch (error) {
			Logger.warn(`[ProfileChangeCoordinator] Post-commit notification failed for task ${task?.taskId ?? "none"}`, error)
		}
	}

	private adoptTaskBinding(
		profileId: string | undefined,
		profileName: string | undefined,
		mode: "plan" | "act",
		changes: Map<string, ProfileChange>,
		taskState: {
			adoptProfileIdentity: (mode: "plan" | "act", profileId: string, profileName: string) => void
		},
	): void {
		const change = this.findBindingChange(profileId, profileName, changes)
		const profile = change?.nextProfile
		if (profile) {
			taskState.adoptProfileIdentity(mode, profile.id, profile.name)
		}
	}

	private adoptGlobalBinding(
		controller: Controller,
		profileId: string | undefined,
		profileName: string | undefined,
		mode: "plan" | "act",
		changes: Map<string, ProfileChange>,
	): void {
		const change = this.findBindingChange(profileId, profileName, changes)
		const profile = change?.nextProfile
		if (!profile) {
			return
		}

		const idKey = mode === "plan" ? "planModeProfileId" : "actModeProfileId"
		const nameKey = mode === "plan" ? "planModeProfile" : "actModeProfile"
		controller.stateManager.setGlobalState(idKey, profile.id)
		controller.stateManager.setGlobalState(nameKey, profile.name)
	}

	private findBindingChange(
		profileId: string | undefined,
		profileName: string | undefined,
		changes: Map<string, ProfileChange>,
	): ProfileChange | undefined {
		if (profileId) {
			return changes.get(profileId)
		}
		if (!profileName) {
			return undefined
		}
		return [...changes.values()].find((change) => change.oldProfile?.name === profileName)
	}

	/** Build stable-ID profile changes for added, updated, renamed, and deleted profiles. */
	private buildChanges(oldProfiles: ApiProfile[], nextProfiles: ApiProfile[]): Map<string, ProfileChange> {
		const oldMap = new Map(oldProfiles.map((profile) => [profile.id, profile]))
		const nextMap = new Map(nextProfiles.map((profile) => [profile.id, profile]))
		const changes = new Map<string, ProfileChange>()
		for (const id of new Set([...oldMap.keys(), ...nextMap.keys()])) {
			const oldProfile = oldMap.get(id)
			const nextProfile = nextMap.get(id)
			if (JSON.stringify(oldProfile) !== JSON.stringify(nextProfile)) {
				changes.set(id, { id, oldProfile, nextProfile })
			}
		}
		return changes
	}
}
