import React from "react"
import { reportWebviewError } from "@/services/webviewErrorReporter"

interface RootErrorBoundaryProps {
	children: React.ReactNode
}

interface RootErrorBoundaryState {
	error: Error | null
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
		return (
			<div
				className="flex h-screen w-full flex-col items-center justify-center gap-3 p-4 text-center"
				data-testid="root-error-boundary">
				<div className="text-[var(--vscode-errorForeground)]">Dline hit an error while rendering this panel.</div>
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
					Reload panel
				</button>
			</div>
		)
	}
}
