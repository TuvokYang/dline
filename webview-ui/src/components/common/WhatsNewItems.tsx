import whatsNew from "virtual:dline-whats-new"
import React from "react"
import { repositoryFileUrl } from "@/config/source-links"
import type { WhatsNewInline } from "@/config/whats-new-release"

interface WhatsNewItemsProps {
	inlineCodeStyle: React.CSSProperties
}

const CHANGELOG_URL = repositoryFileUrl("docs/changelog/CHANGELOG_en.md")
const LINK_STYLE: React.CSSProperties = { color: "var(--vscode-textLink-foreground)" }

function renderInline(run: WhatsNewInline, inlineCodeStyle: React.CSSProperties): React.ReactNode {
	switch (run.kind) {
		case "text":
			return run.text
		case "strong":
			return <strong>{run.text}</strong>
		case "code":
			return <code style={inlineCodeStyle}>{run.text}</code>
		case "link":
			return (
				<a href={run.href} rel="noopener noreferrer" style={LINK_STYLE} target="_blank">
					{run.text}
				</a>
			)
	}
}

/** Highlights of the newest release, parsed at build time from docs/whats-new/WHATS_NEW_en.md. */
export const WhatsNewItems: React.FC<WhatsNewItemsProps> = ({ inlineCodeStyle }) => {
	return (
		<div className="text-sm" style={{ color: "var(--vscode-descriptionForeground)" }}>
			<ul className="list-disc pl-5 space-y-2 m-0">
				{whatsNew.items.map((item, itemIndex) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the list is a build-time constant and never reorders.
					<li key={itemIndex}>
						{item.map((run, runIndex) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: runs are a build-time constant and never reorder.
							<React.Fragment key={runIndex}>{renderInline(run, inlineCodeStyle)}</React.Fragment>
						))}
					</li>
				))}
			</ul>
			<p className="mt-3 mb-0">
				See the{" "}
				<a href={CHANGELOG_URL} rel="noopener noreferrer" style={LINK_STYLE} target="_blank">
					full changelog
				</a>{" "}
				for every change.
			</p>
		</div>
	)
}

export default WhatsNewItems
