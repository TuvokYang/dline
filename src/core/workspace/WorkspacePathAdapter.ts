/**
 * WorkspacePathAdapter - Utility for resolving paths in single or multi-workspace environments
 *
 * This adapter provides a unified interface for path resolution that works with both
 * single-root (legacy) and multi-root workspace configurations. It encapsulates the
 * logic for determining which workspace a path belongs to and resolving relative paths
 * to their absolute equivalents.
 */

import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { normalizeWorkspaceRelativeInputPath } from "./utils/normalizeWorkspaceRelativeInputPath"
import { resolveWorkspacePath } from "./WorkspaceResolver"
import type { WorkspaceRootManager } from "./WorkspaceRootManager"

export interface WorkspaceAdapterConfig {
    cwd: string
    isMultiRootEnabled?: boolean
    workspaceManager?: WorkspaceRootManager
}

export class WorkspacePathAdapter {
    constructor(private config: WorkspaceAdapterConfig) {}

    /**
     * Resolves a path using either single-root or multi-root logic
     *
     * @param relativePath - The path to resolve (can be relative or absolute)
     * @param workspaceHint - Optional hint for which workspace to use (name or path)
     * @returns The resolved absolute path
     */
    resolvePath(relativePath: string, workspaceHint?: string): string {
        // Normalize input to prevent Windows path.resolve/path.join from misinterpreting
        // a leading "/" as a drive-relative absolute path
        const rel = normalizeWorkspaceRelativeInputPath(relativePath)

        // Single-root mode (backward compatible)
        if (!this.config.isMultiRootEnabled || !this.config.workspaceManager) {
            return resolveWorkspacePath(this.config.cwd, rel, "WorkspacePathAdapter") as string
        }

        // Multi-root mode
        const manager = this.config.workspaceManager as WorkspaceRootManager

        // If absolute path, find which workspace it belongs to
        if (path.isAbsolute(rel)) {
            // Already absolute, just validate it belongs to a workspace
            const root = manager.resolvePathToRoot(rel)
            if (!root) {
                // Diagnostic: log context to help identify root cause
                const roots = manager.getRoots()
                Logger.debug(
                    `[WorkspacePathAdapter] Path not in any workspace. path="${rel}", cwd="${this.config.cwd}", roots=[${roots.map((r) => r.path).join(", ")}]`,
                )
                // Path doesn't belong to any workspace, but return it anyway
                Logger.warn(`[WorkspacePathAdapter] Absolute path ${rel} doesn't belong to any workspace`)
            }
            return rel
        }

        // If hint provided, try to use that workspace
        if (workspaceHint) {
            // Try by name first
            let root = manager.getRootByName(workspaceHint)

            // If not found by name, try to find a root that contains the hint path
            if (!root) {
                const roots = manager.getRoots()
                root = roots.find((r) => r.path === workspaceHint || r.path.includes(workspaceHint))
            }

            if (root) {
                // If no relative path specified, return the workspace root itself
                if (!rel) {
                    return root.path
                }
                return path.join(root.path, rel)
            }

            Logger.warn(`[WorkspacePathAdapter] Workspace hint '${workspaceHint}' not found, using primary workspace`)
        }

        // Default to primary workspace
        const primaryRoot = manager.getPrimaryRoot()
        if (primaryRoot) {
            // If no relative path specified, return the workspace root itself
            if (!rel) {
                return primaryRoot.path
            }
            return path.join(primaryRoot.path, rel)
        }

        // Fallback to cwd if no roots (shouldn't happen, but defensive)
        Logger.warn(`[WorkspacePathAdapter] No workspace roots found, falling back to cwd`)
        return resolveWorkspacePath(this.config.cwd, rel, "WorkspacePathAdapter-fallback") as string
    }

    /**
     * Gets all possible paths for a relative path across all workspaces
     * Useful for search operations or when checking if a file exists in any workspace
     *
     * @param relativePath - The relative path to resolve
     * @returns Array of absolute paths, one for each workspace
     */
    getAllPossiblePaths(relativePath: string): string[] {
        // Normalize input to prevent Windows path.join from misinterpreting
        // a leading "/" as a drive-relative absolute path
        const rel = normalizeWorkspaceRelativeInputPath(relativePath)

        // Absolute paths should not be joined with workspace roots.
        // path.join() concatenates unconditionally (unlike path.resolve()),
        // so we must return the absolute path directly to avoid
        // e.g. path.join("e:\\root", "e:\\root") → "e:\\root\\e:\\root".
        if (path.isAbsolute(rel)) {
            return [rel]
        }

        // Single-root mode
        if (!this.config.isMultiRootEnabled || !this.config.workspaceManager) {
            return [resolveWorkspacePath(this.config.cwd, rel, "WorkspacePathAdapter-getAllPaths") as string]
        }

        // Multi-root mode
        const manager = this.config.workspaceManager as WorkspaceRootManager
        return manager.getRoots().map((root) => path.join(root.path, rel))
    }

    /**
     * Determines which workspace a given absolute path belongs to
     *
     * @param absolutePath - The absolute path to check
     * @returns The workspace root that contains this path, or undefined if not in any workspace
     */
    getWorkspaceForPath(absolutePath: string): { name: string; path: string } | undefined {
        // Single-root mode
        if (!this.config.isMultiRootEnabled || !this.config.workspaceManager) {
            // In single-root, check if path is within cwd
            // Use path.relative for cross-platform safe comparison (handles / vs \ on Windows)
            const rel = path.relative(this.config.cwd, absolutePath)
            if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                return {
                    name: path.basename(this.config.cwd),
                    path: this.config.cwd,
                }
            }
            return undefined
        }

        // Multi-root mode
        const manager = this.config.workspaceManager as WorkspaceRootManager
        const root = manager.resolvePathToRoot(absolutePath)
        if (root) {
            return {
                name: root.name || path.basename(root.path),
                path: root.path,
            }
        }

        return undefined
    }

    /**
     * Gets the relative path from the appropriate workspace root
     *
     * @param absolutePath - The absolute path to make relative
     * @returns The relative path from its workspace root, or the original path if not in a workspace
     */
    getRelativePath(absolutePath: string): string {
        // Single-root mode
        if (!this.config.isMultiRootEnabled || !this.config.workspaceManager) {
            // Use path.relative for cross-platform safe comparison (handles / vs \ on Windows)
            const rel = path.relative(this.config.cwd, absolutePath)
            if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                return rel
            }
            return absolutePath
        }

        // Multi-root mode
        const manager = this.config.workspaceManager as WorkspaceRootManager
        const relativePath = manager.getRelativePathFromRoot(absolutePath)
        return relativePath || absolutePath
    }

    /**
     * Checks if multi-root mode is enabled
     *
     * @returns True if multi-root mode is enabled and configured
     */
    isMultiRootEnabled(): boolean {
        return !!(this.config.isMultiRootEnabled && this.config.workspaceManager)
    }

    /**
     * Gets all workspace roots
     *
     * @returns Array of workspace root information
     */
    getWorkspaceRoots(): Array<{ name: string; path: string }> {
        // Single-root mode
        if (!this.config.isMultiRootEnabled || !this.config.workspaceManager) {
            return [
                {
                    name: path.basename(this.config.cwd),
                    path: this.config.cwd,
                },
            ]
        }

        // Multi-root mode
        const manager = this.config.workspaceManager as WorkspaceRootManager
        return manager.getRoots().map((root) => ({
            name: root.name || path.basename(root.path),
            path: root.path,
        }))
    }

    /**
     * Gets the primary workspace root
     *
     * @returns The primary workspace root information
     */
    getPrimaryWorkspace(): { name: string; path: string } {
        // Single-root mode
        if (!this.config.isMultiRootEnabled || !this.config.workspaceManager) {
            return {
                name: path.basename(this.config.cwd),
                path: this.config.cwd,
            }
        }

        // Multi-root mode
        const manager = this.config.workspaceManager as WorkspaceRootManager
        const primaryRoot = manager.getPrimaryRoot()
        if (primaryRoot) {
            return {
                name: primaryRoot.name || path.basename(primaryRoot.path),
                path: primaryRoot.path,
            }
        }

        // Fallback (shouldn't happen)
        return {
            name: path.basename(this.config.cwd),
            path: this.config.cwd,
        }
    }
}

/**
 * Factory function to create a WorkspacePathAdapter
 *
 * @param config - The task configuration
 * @returns A new WorkspacePathAdapter instance
 */
export function createWorkspacePathAdapter(config: WorkspaceAdapterConfig): WorkspacePathAdapter {
    return new WorkspacePathAdapter(config)
}
