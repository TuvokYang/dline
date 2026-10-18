import { useCallback } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { formatWorkspaceDisplayPath, type WorkspacePathFormatter } from "@/utils/workspaceDisplayPath"

const NO_ROOTS: [] = []

function useWorkspaceFolders() {
    try {
        const { workspaceRoots, primaryRootIndex } = useExtensionState()
        return { workspaceRoots: workspaceRoots ?? NO_ROOTS, primaryRootIndex: primaryRootIndex ?? 0 }
    } catch {
        // Rows are also drawn outside the extension state provider (stories and isolated
        // renders). The context is still read on every render, so hook order is stable;
        // without folders a path is shown as reported.
        return { workspaceRoots: NO_ROOTS, primaryRootIndex: 0 }
    }
}

/** Formats reported paths against the folders of the open workspace; see `formatWorkspaceDisplayPath`. */
export function useWorkspaceDisplayPath(): WorkspacePathFormatter {
    const { workspaceRoots, primaryRootIndex } = useWorkspaceFolders()
    return useCallback(
        (reportedPath: string) => formatWorkspaceDisplayPath(reportedPath, { workspaceRoots, primaryRootIndex }),
        [workspaceRoots, primaryRootIndex],
    )
}
