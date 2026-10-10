import { MAX_ERROR_MESSAGE_LENGTH, TELEMETRY_EVENTS, TELEMETRY_METRICS } from "./catalog"
import { DomainRecorder } from "./domain-recorder"

/**
 * Workspace, multi-root, and worktree telemetry.
 *
 * Paths never appear here — only counts, types, and outcomes — because a
 * workspace path names the user's machine and often their employer.
 */
export class WorkspaceEventRecorder extends DomainRecorder {
    /**
     * Records when workspace is initialized
     * @param rootCount Number of workspace roots
     * @param vcsTypes Array of VCS types detected
     * @param initDurationMs Time taken to initialize in milliseconds
     * @param featureFlagEnabled Whether multi-root feature flag is enabled
     */
    captureWorkspaceInitialized(
        rootCount: number,
        vcsTypes: string[],
        initDurationMs?: number,
        featureFlagEnabled?: boolean,
    ): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKSPACE.INITIALIZED, {
            root_count: rootCount,
            vcs_types: vcsTypes,
            is_multi_root: rootCount > 1,
            has_git: vcsTypes.includes("Git"),
            has_mercurial: vcsTypes.includes("Mercurial"),
            init_duration_ms: initDurationMs,
            feature_flag_enabled: featureFlagEnabled,
        })

        const isMultiRoot = rootCount > 1
        this.sink.recordGauge(TELEMETRY_METRICS.WORKSPACE.ACTIVE_ROOTS, rootCount, { is_multi_root: isMultiRoot })
        // Retire the previous series to avoid leaking gauge entries when the flag flips.
        this.sink.recordGauge(TELEMETRY_METRICS.WORKSPACE.ACTIVE_ROOTS, null, { is_multi_root: !isMultiRoot })
    }

    /**
     * Records workspace initialization errors
     * @param error The error that occurred
     * @param fallbackMode Whether system fell back to single-root mode
     * @param workspaceCount Number of workspace folders detected
     */
    captureWorkspaceInitError(error: Error, fallbackMode: boolean, workspaceCount?: number): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKSPACE.INIT_ERROR, {
            error_type: error.constructor.name,
            error_message: error.message.substring(0, MAX_ERROR_MESSAGE_LENGTH),
            fallback_to_single_root: fallbackMode,
            workspace_count: workspaceCount ?? 0,
        })
    }

    /**
     * Records multi-root checkpoint operations
     * @param ulid Task identifier
     * @param action Type of checkpoint action
     * @param rootCount Number of roots being checkpointed
     * @param successCount Number of successful checkpoints
     * @param failureCount Number of failed checkpoints
     * @param durationMs Total operation duration in milliseconds
     */
    captureMultiRootCheckpoint(
        ulid: string,
        action: "initialized" | "committed" | "restored",
        rootCount: number,
        successCount: number,
        failureCount: number,
        durationMs?: number,
    ): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKSPACE.MULTI_ROOT_CHECKPOINT, {
            ulid,
            action,
            root_count: rootCount,
            success_count: successCount,
            failure_count: failureCount,
            success_rate: rootCount > 0 ? successCount / rootCount : 0,
            duration_ms: durationMs,
        })
    }

    /**
     * Records workspace path resolution events
     * @param ulid Unique identifier for the task
     * @param context The component/handler where resolution occurred
     * @param resolutionType Type of resolution performed
     * @param hintType Type of workspace hint provided (if any)
     * @param resolutionSuccess Whether the resolution was successful
     * @param targetWorkspaceIndex Index of the resolved workspace (0=primary, 1=secondary, etc.)
     * @param isMultiRootEnabled Whether multi-root mode is enabled
     */
    captureWorkspacePathResolved(
        ulid: string,
        context: string,
        resolutionType: "hint_provided" | "fallback_to_primary" | "cross_workspace_search",
        hintType?: "workspace_name" | "workspace_path" | "invalid",
        resolutionSuccess?: boolean,
        targetWorkspaceIndex?: number,
        isMultiRootEnabled?: boolean,
    ): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKSPACE.PATH_RESOLVED, {
            ulid,
            context,
            resolution_type: resolutionType,
            hint_type: hintType,
            resolution_success: resolutionSuccess,
            target_workspace_index: targetWorkspaceIndex,
            is_multi_root_enabled: isMultiRootEnabled,
        })
    }

    /**
     * Records multi-workspace search patterns and performance
     * @param ulid Unique identifier for the task
     * @param searchType Type of search performed
     * @param workspaceCount Number of workspaces searched
     * @param hintProvided Whether a workspace hint was provided
     * @param resultsFound Whether search results were found
     * @param searchDurationMs Optional search duration in milliseconds
     */
    captureWorkspaceSearchPattern(
        ulid: string,
        searchType: "targeted" | "cross_workspace" | "primary_only",
        workspaceCount: number,
        hintProvided: boolean,
        resultsFound: boolean,
        searchDurationMs?: number,
    ): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.TASK.WORKSPACE_SEARCH_PATTERN, {
            ulid,
            search_type: searchType,
            workspace_count: workspaceCount,
            hint_provided: hintProvided,
            results_found: resultsFound,
            search_duration_ms: searchDurationMs,
        })
    }

    /**
     * Records when user opens the worktrees view
     * @param source Where the user opened the view from (home_page or menu_bar)
     */
    captureWorktreeViewOpened(source: "home_page" | "menu_bar"): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKTREE.VIEW_OPENED, { source })
    }

    /**
     * Records when a worktree is created
     * @param success Whether the creation was successful
     * @param worktreeCount Total number of worktrees after creation (to track power users)
     */
    captureWorktreeCreated(success: boolean, worktreeCount?: number): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKTREE.CREATED, { success, worktree_count: worktreeCount })
    }

    /**
     * Records when a worktree merge is attempted
     * @param success Whether the merge was successful
     * @param hasConflicts Whether merge conflicts were detected
     * @param deleteAfterMerge Whether user chose to delete worktree after merge
     */
    captureWorktreeMergeAttempted(success: boolean, hasConflicts: boolean, deleteAfterMerge: boolean): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.WORKTREE.MERGE_ATTEMPTED, {
            success,
            has_conflicts: hasConflicts,
            delete_after_merge: deleteAfterMerge,
        })
    }
}
