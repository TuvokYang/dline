import { Logger } from "@/shared/services/Logger"
import { Controller } from "../controller/index"
import { ProfileChangeCoordinator } from "../profiles/ProfileChangeCoordinator"
import { TaskCollaborationRuntime } from "../task/collaboration/TaskCollaborationRuntime"

/**
 * OrchestratorController — maintains a registry of all active Controllers
 * and serves as the factory for creating new task instances.
 *
 * The first controller (sidebar) is the "main" controller.
 * Additional controllers are created for Editor Tab panels or via spawn_task.
 */
export class OrchestratorController {
    private static instance: OrchestratorController | null = null

    private mainController?: Controller
    /** Registry of all active controllers keyed by taskId. */
    private controllers = new Map<string, Controller>()
    /** Parent → child task relationship tracker. */
    private spawnRelations = new Map<string, string[]>()
    readonly profileChanges: ProfileChangeCoordinator
    readonly collaboration: TaskCollaborationRuntime

    private constructor() {
        this.profileChanges = new ProfileChangeCoordinator(() => this.getActiveControllers())
        this.collaboration = new TaskCollaborationRuntime()
    }

    static initialize(): OrchestratorController {
        if (!OrchestratorController.instance) {
            OrchestratorController.instance = new OrchestratorController()
            Logger.log("[OrchestratorController] Initialized")
        }
        return OrchestratorController.instance
    }

    static getInstance(): OrchestratorController {
        if (!OrchestratorController.instance) {
            throw new Error("OrchestratorController not initialized")
        }
        return OrchestratorController.instance
    }

    /** Register the main (sidebar) controller */
    registerMainController(controller: Controller): void {
        this.mainController = controller
    }

    /** Get the main controller */
    getMainController(): Controller | undefined {
        return this.mainController
    }

    /** Register a controller under its taskId. Called after initTask returns the taskId. */
    registerController(taskId: string, controller: Controller): void {
        this.controllers.set(taskId, controller)
        Logger.log(`[OrchestratorController] Registered controller for task ${taskId}`)
    }

    /** Unregister a controller and remove stale parent/child references. */
    unregisterController(taskId: string): void {
        this.controllers.delete(taskId)
        for (const [parentTaskId, childTaskIds] of this.spawnRelations) {
            const activeChildren = childTaskIds.filter(
                (childTaskId) => childTaskId !== taskId && this.controllers.has(childTaskId),
            )
            if (activeChildren.length > 0) {
                this.spawnRelations.set(parentTaskId, activeChildren)
            } else {
                this.spawnRelations.delete(parentTaskId)
            }
        }
        Logger.log(`[OrchestratorController] Unregistered controller for task ${taskId}`)
    }

    /** Get a controller by taskId. Returns undefined if not found. */
    getController(taskId: string): Controller | undefined {
        return this.controllers.get(taskId)
    }

    /**
     * Return active controllers registered in this VS Code extension process.
     * @returns A snapshot array that callers can read without mutating the registry.
     */
    getActiveControllers(): Controller[] {
        const controllers = new Set(this.controllers.values())
        if (this.mainController) controllers.add(this.mainController)
        return Array.from(controllers)
    }

    /** Get count of active controllers (sidebar + panels). */
    getControllerCount(): number {
        return this.controllers.size
    }

    /** Called when a new panel is created (non-spawn). */
    onPanelCreated(): void {
        // Count is now derived from controllers.size
    }

    /** Called when a panel is disposed. */
    onPanelDisposed(): void {
        // Count is now derived from controllers.size
    }

    /**
     * Record a spawn relationship: parentTaskId → childTaskId.
     */
    recordSpawn(parentTaskId: string, childTaskId: string): void {
        const children = this.spawnRelations.get(parentTaskId) ?? []
        if (!children.includes(childTaskId)) {
            this.spawnRelations.set(parentTaskId, [...children, childTaskId])
        }
        Logger.log(`[OrchestratorController] Recorded spawn: ${parentTaskId} → ${childTaskId}`)
    }

    /**
     * Get all child task IDs spawned from the given parent task.
     */
    getSpawnedTaskIds(parentTaskId: string): string[] {
        return [...(this.spawnRelations.get(parentTaskId) ?? [])]
    }

    /**
     * Get the parent task ID for a child task, if known.
     */
    getParentTaskId(childTaskId: string): string | undefined {
        for (const [parentId, children] of this.spawnRelations) {
            if (children.includes(childTaskId)) {
                return parentId
            }
        }
        return undefined
    }

    /**
     * Spawn a new sub-task from the parent task's context.
     * Registers the child controller and records the spawn relationship.
     * The caller is responsible for creating the panel and initializing the task.
     *
     * @param childTaskId The taskId of the spawned task
     * @param childController The new Controller for the spawned task
     * @param parentTaskId The parent task's ID
     * @returns The child taskId (same as input, for chaining)
     */
    spawnTask(childTaskId: string, childController: Controller, parentTaskId: string): string {
        if (!childTaskId) {
            throw new Error("spawnTask failed: childTaskId is required")
        }
        if (!childController) {
            throw new Error("spawnTask failed: childController is required")
        }
        if (!parentTaskId) {
            throw new Error("spawnTask failed: parentTaskId is required")
        }

        this.registerController(childTaskId, childController)
        this.recordSpawn(parentTaskId, childTaskId)
        Logger.log(`[OrchestratorController] Spawned task ${childTaskId} from parent ${parentTaskId}`)

        return childTaskId
    }

    /** Reset for testing */
    static reset(): void {
        OrchestratorController.instance = null
    }
}
