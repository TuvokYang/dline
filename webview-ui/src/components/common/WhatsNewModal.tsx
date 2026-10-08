import React from "react"
import { useMount } from "react-use"
import GitHubIcon from "@/assets/GitHubIcon"
import WhatsNewItems from "@/components/common/WhatsNewItems"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { DLINE_REPOSITORY_URL } from "@/config/source-links"
import { useExtensionState } from "@/context/ExtensionStateContext"

interface WhatsNewModalProps {
	open: boolean
	onClose: () => void
	version: string
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ open, onClose, version }) => {
	const { refreshOpenRouterModels } = useExtensionState()

	// Get latest model list in case user hits shortcut button to set model
	useMount(refreshOpenRouterModels)

	const inlineCodeStyle: React.CSSProperties = {
		backgroundColor: "var(--vscode-textCodeBlock-background)",
		padding: "2px 6px",
		borderRadius: "3px",
		fontFamily: "var(--vscode-editor-font-family)",
		fontSize: "0.9em",
	}

	return (
		<Dialog onOpenChange={(isOpen) => !isOpen && onClose()} open={open}>
			<DialogContent
				aria-describedby="whats-new-description"
				aria-labelledby="whats-new-title"
				className="pt-5 px-5 pb-4 gap-0">
				<div id="whats-new-description">
					<h2
						className="text-lg font-semibold mb-3 pr-6"
						id="whats-new-title"
						style={{ color: "var(--vscode-editor-foreground)" }}>
						🎉 New in v{version}
					</h2>

					<WhatsNewItems inlineCodeStyle={inlineCodeStyle} onClose={onClose} />

					{/* Repository Section */}
					<div className="flex flex-col items-center gap-3 mt-4 pt-4 border-t border-[var(--vscode-widget-border)]">
						<div className="flex items-center gap-4">
							<a
								aria-label="Star us on GitHub"
								className="text-[var(--vscode-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] transition-colors"
								href={DLINE_REPOSITORY_URL}
								rel="noopener noreferrer"
								target="_blank">
								<GitHubIcon />
							</a>
						</div>

						{/* GitHub Star CTA */}
						<p className="text-sm text-center" style={{ color: "var(--vscode-descriptionForeground)" }}>
							Please support Dline by{" "}
							<a
								href={DLINE_REPOSITORY_URL}
								rel="noopener noreferrer"
								style={{ color: "var(--vscode-textLink-foreground)" }}
								target="_blank">
								starring us on GitHub
							</a>
							.
						</p>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default WhatsNewModal
