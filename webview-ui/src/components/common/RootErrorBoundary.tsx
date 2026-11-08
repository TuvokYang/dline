import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage, type UiLanguage } from "@shared/UiLanguage"
import React from "react"
import { translateUi, type UiTranslator } from "@/i18n/messages"
import { reportWebviewError } from "@/services/webviewErrorReporter"

interface RootErrorBoundaryProps {
    children: React.ReactNode
}

interface RootErrorBoundaryState {
    error: Error | null
}

/**
 * Resolve the display language for the boundary's own fallback.
 *
 * The boundary wraps the whole tree, so it renders outside the controlled
 * language Provider and cannot read the preference. It therefore reads only the
 * language the root has already projected onto `document.documentElement.lang`
 * and treats anything unrecognised - including a panel that never hydrated - as
 * the safe English baseline. This introduces no new preference authority.
 */
function fallbackTranslator(): UiTranslator {
    if (typeof document === "undefined") return (key, ...args) => translateUi(DEFAULT_UI_LANGUAGE, key, ...args)
    const language: UiLanguage = normalizeUiLanguage(document.documentElement.lang)
    return (key, ...args) => translateUi(language, key, ...args)
}

/**
 * Last line of defense for the whole Webview tree.
 *
 * Without it an uncaught render error unmounts everything and leaves an empty
 * panel with no text and no way out, which is indistinguishable from a hang.
 * This keeps a visible explanation and a reload action on screen and reports
 * the failure to the extension.
 */
export class RootErrorBoundary extends React.Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
    state: RootErrorBoundaryState = { error: null }

    static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
        return { error }
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        reportWebviewError("render", error, errorInfo.componentStack ?? undefined)
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children

        const t = fallbackTranslator()
        return (
            <div
                className="flex h-screen w-full flex-col items-center justify-center gap-3 p-4 text-center"
                data-testid="root-error-boundary">
                <div className="text-[var(--vscode-errorForeground)]">{t("shell.errorBoundary.title")}</div>
                <div
                    className="max-w-full break-words text-sm text-[var(--vscode-descriptionForeground)]"
                    data-testid="root-error-message">
                    {error.message || error.name}
                </div>
                <button
                    className="cursor-pointer rounded border border-[var(--vscode-button-border)] bg-[var(--vscode-button-background)] px-3 py-1 text-[var(--vscode-button-foreground)]"
                    data-testid="root-error-reload"
                    onClick={() => window.location.reload()}
                    type="button">
                    {t("shell.errorBoundary.reload")}
                </button>
            </div>
        )
    }
}
