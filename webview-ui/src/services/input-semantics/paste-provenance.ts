import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { isMentionNode, isSlashCommandNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import { lexSemanticInput, type SemanticActivation, semanticCandidateSpans } from "@shared/input-semantics/lexer"

/** A half-open UTF-16 range `[start, end)` of composer text. */
export interface TextSpan {
	readonly start: number
	readonly end: number
}

/**
 * Which characters of one composer text arrived by paste.
 *
 * The spans are only meaningful for exactly `text`; every edit must carry them
 * forward with {@link rebaseProvenance} before they are read again.
 */
export interface PasteProvenance {
	readonly text: string
	readonly spans: readonly TextSpan[]
}

export const EMPTY_PASTE_PROVENANCE: PasteProvenance = { text: "", spans: [] }

/** Sorted, non-empty and non-overlapping; adjacent pastes read as one. */
function normalizeSpans(spans: readonly TextSpan[]): TextSpan[] {
	const sorted = spans.filter((span) => span.end > span.start).sort((left, right) => left.start - right.start)
	const merged: TextSpan[] = []
	for (const span of sorted) {
		const last = merged[merged.length - 1]
		if (last && span.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) }
		else merged.push(span)
	}
	return merged
}

/**
 * Carry spans across one edit that replaced `[editStart, editEnd)` of the old
 * text with `insertedLength` new characters.
 *
 * Characters outside the edit keep their provenance; characters the edit
 * produced are not pasted, because the user typed or inserted them.
 */
function spansAcrossEdit(spans: readonly TextSpan[], editStart: number, editEnd: number, insertedLength: number): TextSpan[] {
	const delta = insertedLength - (editEnd - editStart)
	const carried: TextSpan[] = []
	for (const span of spans) {
		if (span.start < editStart) carried.push({ start: span.start, end: Math.min(span.end, editStart) })
		if (span.end > editEnd) carried.push({ start: Math.max(span.start, editEnd) + delta, end: span.end + delta })
	}
	return normalizeSpans(carried)
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length)
	let length = 0
	while (length < limit && left[length] === right[length]) length++
	return length
}

function commonSuffixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length)
	let length = 0
	while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length++
	return length
}

/**
 * Follow the composer text to `nextText`.
 *
 * Only the two texts are known, not where the edit happened, and repeated
 * characters make several explanations equally plausible: deleting the first
 * of two identical commands looks exactly like deleting the second. A pasted
 * character therefore keeps its provenance at every position some plausible
 * explanation could have moved it to. At worst that holds a typed neighbour
 * back, which the user releases by picking it from the menu; the opposite
 * choice could run a pasted command, which nothing could undo.
 *
 * `insertedIsPasted` also marks the widest changed region as pasted, for a
 * paste whose exact range could not be observed.
 */
export function rebaseProvenance(provenance: PasteProvenance, nextText: string, insertedIsPasted = false): PasteProvenance {
	const previous = provenance.text
	if (previous === nextText) return provenance
	if (provenance.spans.length === 0 && !insertedIsPasted) return { text: nextText, spans: [] }

	const prefix = commonPrefixLength(previous, nextText)
	const suffix = commonSuffixLength(previous, nextText)
	const shortest = Math.min(previous.length, nextText.length)
	const delta = nextText.length - previous.length
	const suffixStart = previous.length - suffix
	const carried: TextSpan[] = []
	for (const span of provenance.spans) {
		// Unmoved, under the explanation that keeps the longest prefix.
		if (span.start < prefix) carried.push({ start: span.start, end: Math.min(span.end, prefix) })
		// Shifted, under the explanation that keeps the longest suffix.
		if (span.end > suffixStart) carried.push({ start: Math.max(span.start, suffixStart) + delta, end: span.end + delta })
	}
	if (insertedIsPasted) {
		carried.push({
			start: Math.min(prefix, shortest - suffix),
			end: nextText.length - Math.min(suffix, shortest - prefix),
		})
	}
	return { text: nextText, spans: normalizeSpans(carried) }
}

/**
 * Follow a paste the browser inserted natively.
 *
 * The exact range is used when the new text is precisely the recorded
 * replacement. Otherwise the browser changed the text differently than
 * predicted - a line ending it kept, a selection it adjusted - and both the
 * recorded range and the changed region count as pasted instead of guessing.
 */
export function followNativePaste(
	base: PasteProvenance,
	paste: { readonly start: number; readonly end: number; readonly text: string },
	nextText: string,
): PasteProvenance {
	const pasted = paste.text.replace(/\r\n?/g, "\n")
	const expected = base.text.slice(0, paste.start) + pasted + base.text.slice(paste.end)
	if (expected === nextText) return recordPaste(base, paste.start, paste.end, pasted)
	const rebased = rebaseProvenance(base, nextText, true)
	const recorded = {
		start: Math.min(paste.start, nextText.length),
		end: Math.min(paste.start + paste.text.length, nextText.length),
	}
	return { text: nextText, spans: normalizeSpans([...rebased.spans, recorded]) }
}

/** Record a paste that replaced `[start, end)` of the current text with `pasted`. */
export function recordPaste(provenance: PasteProvenance, start: number, end: number, pasted: string): PasteProvenance {
	const previous = provenance.text
	const nextText = previous.slice(0, start) + pasted + previous.slice(end)
	const carried = spansAcrossEdit(provenance.spans, start, end, pasted.length)
	return { text: nextText, spans: normalizeSpans([...carried, { start, end: start + pasted.length }]) }
}

/**
 * Promote one range to typed input, as when the user picks a candidate from a menu.
 *
 * `provenance` must already describe the text that contains the range.
 */
export function confirmRange(provenance: PasteProvenance, range: TextSpan): PasteProvenance {
	const spans: TextSpan[] = []
	for (const span of provenance.spans) {
		if (span.end <= range.start || span.start >= range.end) {
			spans.push(span)
			continue
		}
		if (span.start < range.start) spans.push({ start: span.start, end: range.start })
		if (span.end > range.end) spans.push({ start: range.end, end: span.end })
	}
	return { text: provenance.text, spans: normalizeSpans(spans) }
}

function overlapsAny(spans: readonly TextSpan[], start: number, end: number): boolean {
	return spans.some((span) => span.start < end && start < span.end)
}

/** Every range of `text` outside `live`, as held spans. */
function holdAllExcept(text: string, live: readonly TextSpan[]): TextSpan[] {
	const held: TextSpan[] = []
	let cursor = 0
	for (const span of normalizeSpans(live)) {
		if (span.start > cursor) held.push({ start: cursor, end: span.start })
		cursor = Math.max(cursor, span.end)
	}
	if (cursor < text.length) held.push({ start: cursor, end: text.length })
	return held
}

/** Whether a held span touches any candidate the grammar finds, whether or not a catalog knows it. */
function holdsAnyCandidate(text: string, spans: readonly TextSpan[]): boolean {
	return (
		spans.length > 0 && semanticCandidateSpans(text).some((candidate) => overlapsAny(spans, candidate.start, candidate.end))
	)
}

/**
 * The activation rule for one text: a candidate touching pasted characters
 * stays a candidate until the user confirms it (WS-041 AC-09); anything typed
 * activates as it always has.
 */
export function pasteAwareActivation(spans: readonly TextSpan[]): (start: number, end: number) => SemanticActivation {
	return (start, end) => (overlapsAny(spans, start, end) ? "candidate_only" : "auto")
}

/**
 * Candidates the catalog would run that are held back because they were pasted.
 *
 * These are what the composer has to name to the user: a held candidate that
 * the catalog does not know would never have executed anyway.
 */
export function heldPastedCandidates(text: string, catalog: InputSemanticCatalog, spans: readonly TextSpan[]): string[] {
	if (spans.length === 0) return []
	const document = lexSemanticInput(text, { catalog, documentId: "held-candidates", activation: "auto" })
	const held: string[] = []
	let offset = 0
	for (const node of document.nodes) {
		const length =
			isSlashCommandNode(node) || isMentionNode(node) ? node.sourceText.length : node.kind === "text" ? node.text.length : 0
		const isEntity = isSlashCommandNode(node) || isMentionNode(node)
		if (isEntity && node.state === "recognized" && overlapsAny(spans, offset, offset + length)) held.push(node.sourceText)
		offset += length
	}
	return held
}

/** Remove surrounding whitespace, carrying each span with the text it covers. */
export function trimProvenance(provenance: PasteProvenance): PasteProvenance {
	const leading = provenance.text.length - provenance.text.trimStart().length
	const text = provenance.text.trim()
	const spans = provenance.spans.map((span) => ({
		start: Math.max(0, span.start - leading),
		end: Math.min(text.length, span.end - leading),
	}))
	return { text, spans: normalizeSpans(spans) }
}

/**
 * The provenance of a draft recalled with its composed document.
 *
 * Only the entities the document activated are known to be typed or
 * confirmed. Everything else - a held candidate, a candidate the catalog did
 * not know yet, plain text that may have been pasted - is held, so no edit
 * after the recall can complete it into a command the user never chose.
 * Holding typed plain text costs at most a menu pick; releasing pasted text
 * could run a command.
 */
export function provenanceFromDocument(document: SemanticInputDocument): PasteProvenance {
	const live: TextSpan[] = []
	let offset = 0
	for (const node of document.nodes) {
		if (node.kind === "text") {
			offset += node.text.length
			continue
		}
		if (!isSlashCommandNode(node) && !isMentionNode(node)) continue
		const end = offset + node.sourceText.length
		if (node.state === "recognized") live.push({ start: offset, end })
		offset = end
	}
	return { text: document.rawText, spans: holdAllExcept(document.rawText, live) }
}

/**
 * The provenance of a draft recalled without a document.
 *
 * A composition carries a document whenever a pasted character touches any
 * candidate, known to the catalog or not, so every candidate of a draft
 * without one was typed and stays live. Nothing tells the remaining
 * characters apart, so they are held: an edit can then never complete pasted
 * text into a command, whatever the catalog has learnt since.
 */
export function provenanceForRecalledText(text: string): PasteProvenance {
	return { text, spans: holdAllExcept(text, semanticCandidateSpans(text)) }
}

/**
 * The provenance of a draft that left the composer and came back - an edited
 * queue entry, a refused or transferred draft - when no exact record survived.
 */
export function provenanceForRecalledDraft(text: string, document?: SemanticInputDocument): PasteProvenance {
	return document?.rawText === text ? provenanceFromDocument(document) : provenanceForRecalledText(text)
}

/** One draft about to leave the composer. */
export interface SubmissionDraft {
	readonly text: string
	/** Pasted spans of `text`. */
	readonly spans: readonly TextSpan[]
	readonly catalog: InputSemanticCatalog
	readonly documentId: string
	/**
	 * Text the composer adds on the user's behalf - a quote, a follow-up option.
	 * The user never typed it, so nothing in it may run; it is held like a paste.
	 */
	readonly literalPrefix?: string
	/** Trim the user's text first, as a new task does. */
	readonly trim?: boolean
}

/** What one submission sends: its text and, when needed, the structure that governs it. */
export interface ComposedSubmission {
	readonly text: string
	readonly semanticInput?: SemanticInputDocument
}

/**
 * Compose the text and structured document of one submission.
 *
 * A document is produced only when a held character touches a candidate.
 * Core's legacy adapter activates every typed candidate exactly as this
 * composer does, so a document for typed text would change nothing except
 * tying the submission to this view's catalog revision. A held candidate the
 * catalog does not know yet still needs one: a queued draft may be delivered
 * or recalled after the catalog learns it, and only the document keeps it held.
 */
export function composeSubmission(draft: SubmissionDraft): ComposedSubmission {
	const clipped = draft.spans.map((span) => ({
		start: Math.max(0, span.start),
		end: Math.min(draft.text.length, span.end),
	}))
	const own: PasteProvenance = { text: draft.text, spans: normalizeSpans(clipped) }
	const body = draft.trim ? trimProvenance(own) : own
	const prefix = draft.literalPrefix ?? ""
	const text = prefix + body.text
	const held = normalizeSpans([
		{ start: 0, end: prefix.length },
		...body.spans.map((span) => ({ start: span.start + prefix.length, end: span.end + prefix.length })),
	])
	if (!holdsAnyCandidate(text, held)) return { text }
	return {
		text,
		semanticInput: lexSemanticInput(text, {
			catalog: draft.catalog,
			documentId: draft.documentId,
			activationAt: pasteAwareActivation(held),
		}),
	}
}

/** A document id unique to one composition. */
export function newComposerDocumentId(): string {
	return `composer:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}
