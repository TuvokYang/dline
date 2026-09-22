import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { StringRequest } from "@shared/proto/dline/common"
import { FileServiceClient } from "@/services/grpc-client"
import { type SemanticHighlightSegment, segmentSentMessage } from "@/services/input-semantics/highlight"
import { useInputSemanticCatalog } from "@/services/input-semantics/useInputSemanticCatalog"

function highlightClass(withShadow: boolean): string {
	return withShadow ? "mention-context-highlight-with-shadow" : "mention-context-highlight"
}

/** Render one segment, keeping a mention clickable and everything else plain. */
function renderSegment(segment: SemanticHighlightSegment, index: number, withShadow: boolean): JSX.Element | string {
	if (!segment.active || segment.role === "text") {
		return segment.text
	}
	if (segment.role === "mention") {
		// The lexer keeps the leading `@` in the source text, while openMention
		// addresses the target without it.
		const target = segment.text.replace(/^@/, "")
		return (
			<span
				className={`${highlightClass(withShadow)} cursor-pointer`}
				key={`mention-${index}`}
				onClick={() => FileServiceClient.openMention(StringRequest.create({ value: target }))}>
				{segment.text}
			</span>
		)
	}
	return (
		<span className={highlightClass(withShadow)} key={`command-${index}`}>
			{segment.text}
		</span>
	)
}

/**
 * Highlight an already-sent message from the shared input semantics.
 *
 * The catalog is passed in rather than read here so this stays a pure render of
 * one text: the same message is shown in several places, and each caller already
 * subscribes to the catalog it should be read against.
 */
export function highlightTextWithCatalog(
	text: string | undefined,
	catalog: InputSemanticCatalog,
	withShadow = true,
): (string | JSX.Element)[] | string | undefined {
	if (!text) {
		return text
	}
	const segments = segmentSentMessage(text, catalog)
	if (!segments.some((segment) => segment.active && segment.role !== "text")) {
		return text
	}
	return segments.map((segment, index) => renderSegment(segment, index, withShadow))
}

/** Hook form for components that render sent text without threading the catalog. */
export function useHighlightedText(text: string | undefined, withShadow = true) {
	const catalog = useInputSemanticCatalog()
	return highlightTextWithCatalog(text, catalog, withShadow)
}
