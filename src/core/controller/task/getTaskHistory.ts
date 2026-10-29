import { GetTaskHistoryRequest, TaskHistoryArray } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import { arePathsEqual, getWorkspacePath } from "../../../utils/path"
import type { Controller } from ".."

/**
 * Gets filtered task history
 * @param controller The controller instance
 * @param request Filter parameters for task history
 * @returns TaskHistoryArray with filtered task list
 */
export async function getTaskHistory(controller: Controller, request: GetTaskHistoryRequest): Promise<TaskHistoryArray> {
    try {
        const { favoritesOnly, currentWorkspaceOnly, resultLimit, searchQuery, sortBy } = request

        // Get task history from global state
        const taskHistory = controller.stateManager.getGlobalStateKey("taskHistory")
        const workspaceManager = currentWorkspaceOnly ? await controller.ensureWorkspaceManager() : undefined
        const workspacePaths = workspaceManager?.getRoots().map((root) => root.path) ?? []
        const legacyWorkspacePath = currentWorkspaceOnly ? await getWorkspacePath() : undefined
        if (legacyWorkspacePath && !workspacePaths.some((root) => arePathsEqual(root, legacyWorkspacePath))) {
            workspacePaths.push(legacyWorkspacePath)
        }

        // Apply filters
        let filteredTasks = taskHistory.filter((item) => {
            // Basic filter: must have timestamp and task content
            const hasRequiredFields = item.ts && item.task
            if (!hasRequiredFields) {
                return false
            }

            // Apply favorites filter if requested
            if (favoritesOnly && !item.isFavorited) {
                return false
            }

            // Apply current workspace filter if requested
            if (currentWorkspaceOnly) {
                let isInWorkspace = false

                // First check the cwdOnTaskInitialization property - Only present on tasks from this change forward
                if (item.cwdOnTaskInitialization) {
                    isInWorkspace = workspacePaths.some((workspacePath) =>
                        arePathsEqual(item.cwdOnTaskInitialization, workspacePath),
                    )
                }

                // For tasks without cwdOnTaskInitialization, check the older shadowGitConfigWorkTree property
                if (!isInWorkspace && item.shadowGitConfigWorkTree) {
                    isInWorkspace = workspacePaths.some((workspacePath) =>
                        arePathsEqual(item.shadowGitConfigWorkTree, workspacePath),
                    )
                }

                if (!isInWorkspace) {
                    return false
                }
            }

            return true
        })

        // Apply search if provided
        if (searchQuery) {
            // Simple search implementation
            const query = searchQuery.toLowerCase()
            filteredTasks = filteredTasks.filter((item) => item.task.toLowerCase().includes(query))
        }

        // Calculate total count before sorting
        const totalCount = filteredTasks.length

        // Apply sorting
        if (sortBy) {
            filteredTasks.sort((a, b) => {
                switch (sortBy) {
                    case "oldest":
                        return a.ts - b.ts
                    case "mostExpensive":
                        return (b.totalCost || 0) - (a.totalCost || 0)
                    case "mostTokens":
                        return (
                            (b.tokensIn || 0) +
                            (b.tokensOut || 0) +
                            (b.cacheWrites || 0) +
                            (b.cacheReads || 0) -
                            ((a.tokensIn || 0) + (a.tokensOut || 0) + (a.cacheWrites || 0) + (a.cacheReads || 0))
                        )
                    default:
                        return b.ts - a.ts
                }
            })
        } else {
            // Default sort by newest
            filteredTasks.sort((a, b) => b.ts - a.ts)
        }

        const responseTasks = resultLimit > 0 ? filteredTasks.slice(0, resultLimit) : filteredTasks

        // Map to response format
        const tasks = responseTasks.map((item) => ({
            id: item.id,
            task: item.task,
            ts: item.ts,
            isFavorited: item.isFavorited || false,
            // A bare `isCompleted` written before the projection existed is not
            // authoritative, so both fields travel together and are only emitted
            // for a canonical revisioned projection.
            isCompleted: item.completionStateRevision !== undefined && item.isCompleted === true,
            completionStateRevision: item.completionStateRevision,
            size: item.size || 0,
            totalCost: item.totalCost || 0,
            currency: item.currency || "",
            tokensIn: item.tokensIn || 0,
            tokensOut: item.tokensOut || 0,
            cacheWrites: item.cacheWrites || 0,
            cacheReads: item.cacheReads || 0,
            modelId: item.modelId || "",
        }))

        return TaskHistoryArray.create({
            tasks,
            totalCount,
        })
    } catch (error) {
        Logger.error("Error in getTaskHistory:", error)
        throw error
    }
}
