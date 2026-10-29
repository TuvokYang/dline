import type { ApiProfile } from "@shared/proto/dline/profile"
import { Logger } from "@shared/services/Logger"
import type { Controller } from "@/core/controller"

interface ProfileChange {
    id: string
    oldProfile?: ApiProfile
    nextProfile?: ApiProfile
}

/**
 * Whether a Profile change alters what a handler built from it would send.
 *
 * A rename only moves the display name the binding is shown under, so it keeps
 * the handler. A deleted or disabled Profile keeps the running handler too: the
 * task stays on what it has until the user picks a replacement.
 */
function changesHandlerConfiguration(change: ProfileChange | undefined): boolean {
    const next = change?.nextProfile
    if (!next || next.enabled === false || !change.oldProfile) return false
    const { name: _previousName, ...previous } = change.oldProfile
    const { name: _nextName, ...current } = next
    return JSON.stringify(previous) !== JSON.stringify(current)
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
        const catalogChanged = JSON.stringify(oldProfiles) !== JSON.stringify(nextProfiles)
        if (!catalogChanged) return

        const changes = this.buildChanges(oldProfiles, nextProfiles)
        this.#revision += 1

        await Promise.all(this.getControllers().map((controller) => this.publishToController(controller, changes)))
    }

    private async publishToController(controller: Controller, changes: Map<string, ProfileChange>): Promise<void> {
        const task = controller.task
        try {
            // Resolve before rename adoption: a name-only binding is found by its old name.
            const activeChange = task ? this.findActiveBindingChange(task.owners.settings, changes) : undefined
            if (task) {
                this.adoptTaskBinding(
                    task.owners.settings.planModeProfileId,
                    task.owners.settings.planModeProfile,
                    "plan",
                    changes,
                    task.owners.settings,
                )
                this.adoptTaskBinding(
                    task.owners.settings.actModeProfileId,
                    task.owners.settings.actModeProfile,
                    "act",
                    changes,
                    task.owners.settings,
                )
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

            if (task) {
                // A handler captures its Profile when it is built, so an edit to the
                // Profile the task runs under (credentials, headers, identity toggles)
                // only reaches the next request through a fresh handler. The request in
                // flight keeps the handler it started with; nothing is aborted.
                if (changesHandlerConfiguration(activeChange)) {
                    await this.rebuildActiveHandler(task)
                }
                // Prompt freshness reads the current handler, so it follows the rebuild.
                await task.owners.prompt.flush("profile_catalog")
            } else {
                await controller.postStateToWebview()
            }
        } catch (error) {
            Logger.warn(`[ProfileChangeCoordinator] Post-commit notification failed for task ${task?.taskId ?? "none"}`, error)
        }
    }

    private findActiveBindingChange(
        settings: {
            readonly mode: string
            readonly planModeProfileId?: string
            readonly planModeProfile?: string
            readonly actModeProfileId?: string
            readonly actModeProfile?: string
        },
        changes: Map<string, ProfileChange>,
    ): ProfileChange | undefined {
        return settings.mode === "plan"
            ? this.findBindingChange(settings.planModeProfileId, settings.planModeProfile, changes)
            : this.findBindingChange(settings.actModeProfileId, settings.actModeProfile, changes)
    }

    /**
     * A failed rebuild keeps the previous handler; the Catalog commit itself already succeeded.
     *
     * A failure the edited Profile caused, such as a rejected API key, no longer
     * describes the handler the next request uses, so it is cleared the same way
     * a Profile switch clears it. Nothing is resent: the user continues by replying.
     */
    private async rebuildActiveHandler(task: NonNullable<Controller["task"]>): Promise<void> {
        try {
            await task.owners.api.rebuild()
        } catch (error) {
            Logger.warn(`[ProfileChangeCoordinator] Active handler rebuild failed for task ${task.taskId}`, error)
            return
        }
        await task.owners.interactions.dismissProviderFailure()
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
