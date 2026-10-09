import React from "react"
import { repositoryFileUrl } from "@/config/source-links"

interface WhatsNewItemsProps {
	onClose: () => void
	inlineCodeStyle: React.CSSProperties
}

const CHANGELOG_URL = repositoryFileUrl("docs/changelog/CHANGELOG_en.md")

export const WhatsNewItems: React.FC<WhatsNewItemsProps> = ({ inlineCodeStyle }) => {
	return (
		<div className="text-sm" style={{ color: "var(--vscode-descriptionForeground)" }}>
			<ul className="list-disc pl-5 space-y-2 m-0">
				<li>
					<strong>Parallel tool calls</strong>: calls in one turn that need no manual approval can run concurrently,
					with a configurable maximum.
				</li>
				<li>
					<strong>Larger subagent batches</strong>: <code style={inlineCodeStyle}>use_subagents</code> runs up to 32
					subagents per call, each with its own agent, Profile, and timeout.
				</li>
				<li>
					<strong>Claude Code and Anthropic</strong>: OAuth sign-in, hosted Web Search and Web Fetch, and Claude Opus
					5.5 as the default model.
				</li>
				<li>
					<strong>Richer attachments</strong>: PDFs are sent whole as native documents, and any text file can be pasted
					or dropped into the input box.
				</li>
				<li>
					<strong>Reliability</strong>: faster history reopen, sturdier compaction, and a TPM rate that counts only
					output tokens.
				</li>
			</ul>
			<p className="mt-3 mb-0">
				See the{" "}
				<a
					href={CHANGELOG_URL}
					rel="noopener noreferrer"
					style={{ color: "var(--vscode-textLink-foreground)" }}
					target="_blank">
					full changelog
				</a>{" "}
				for every change.
			</p>
		</div>
	)
}

export default WhatsNewItems
