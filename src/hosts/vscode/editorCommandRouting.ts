import type { Controller } from "@core/controller"
import type { WebviewProvider } from "@core/webview"

export interface EditorCommandTarget {
    controller: Controller
    surface: "sidebar" | "panel"
}

export interface EditorCommandRoutingOptions {
    preserveEditorFocus?: boolean
    reuseBusySidebar?: boolean
    panelTitle?: string
}

interface EditorCommandRoutingDependencies {
    showSidebar: (preserveEditorFocus: boolean) => Promise<void>
    createPanel: (title: string, sidebar: WebviewProvider) => Promise<Controller>
}

/**
 * Selects the Controller that owns an editor command without replacing an active Sidebar Task.
 */
export async function resolveEditorCommandTarget(
    sidebar: WebviewProvider,
    options: EditorCommandRoutingOptions,
    dependencies: EditorCommandRoutingDependencies,
): Promise<EditorCommandTarget> {
    const sidebarController = sidebar.controller
    if (options.reuseBusySidebar || !sidebarController.task) {
        await dependencies.showSidebar(options.preserveEditorFocus ?? false)
        return { controller: sidebarController, surface: "sidebar" }
    }

    return {
        controller: await dependencies.createPanel(options.panelTitle ?? "Dline", sidebar),
        surface: "panel",
    }
}
