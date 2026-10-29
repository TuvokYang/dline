import * as vscode from "vscode"
import { Logger } from "../shared/services/Logger"

export const EXTENSION_BUNDLE_PATTERN = "dist/extension.js"
const DEFAULT_RELOAD_DEBOUNCE_MS = 300

interface ExtensionReloadContext {
    subscriptions: vscode.Disposable[]
}

interface ExtensionReloadWatcherDependencies {
    createFileSystemWatcher?: (
        workspaceFolder: string,
        pattern: string,
        ignoreCreateEvents: boolean,
        ignoreChangeEvents: boolean,
        ignoreDeleteEvents: boolean,
    ) => vscode.FileSystemWatcher
    reloadWindow?: () => PromiseLike<void> | void
    log?: (message: string) => void
    logError?: (message: string, error: unknown) => void
    debounceMs?: number
}

/**
 * Reloads an interactive Extension Development Host after esbuild publishes a new extension bundle.
 * Watching the bundle instead of source files keeps test-only edits from restarting the debug instance
 * and guarantees that a reload only follows a successful extension build.
 */
export function registerExtensionReloadWatcher(
    context: ExtensionReloadContext,
    workspaceFolder: string,
    dependencies: ExtensionReloadWatcherDependencies = {},
): vscode.Disposable {
    const createFileSystemWatcher =
        dependencies.createFileSystemWatcher ??
        ((folder, pattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents) =>
            vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, pattern),
                ignoreCreateEvents,
                ignoreChangeEvents,
                ignoreDeleteEvents,
            ))
    const reloadWindow =
        dependencies.reloadWindow ?? (() => vscode.commands.executeCommand<void>("workbench.action.reloadWindow"))
    const log = dependencies.log ?? ((message) => Logger.info(message))
    const logError = dependencies.logError ?? ((message, error) => Logger.error(message, error))
    const debounceMs = dependencies.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS
    const watcher = createFileSystemWatcher(workspaceFolder, EXTENSION_BUNDLE_PATTERN, false, false, true)

    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    let reloadInFlight = false
    let disposed = false

    const scheduleReload = (uri: vscode.Uri): void => {
        if (disposed || reloadInFlight) return

        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
            reloadTimer = undefined
            if (disposed || reloadInFlight) return

            reloadInFlight = true
            log(`Extension bundle ${uri.fsPath} changed. Reloading VSCode...`)
            void Promise.resolve(reloadWindow())
                .catch((error) => logError("Failed to reload VS Code after extension rebuild", error))
                .finally(() => {
                    reloadInFlight = false
                })
        }, debounceMs)
    }

    const createSubscription = watcher.onDidCreate(scheduleReload)
    const changeSubscription = watcher.onDidChange(scheduleReload)
    const registration: vscode.Disposable = {
        dispose: () => {
            if (disposed) return
            disposed = true
            if (reloadTimer) {
                clearTimeout(reloadTimer)
                reloadTimer = undefined
            }
            createSubscription.dispose()
            changeSubscription.dispose()
            watcher.dispose()
        },
    }

    context.subscriptions.push(registration)
    return registration
}
