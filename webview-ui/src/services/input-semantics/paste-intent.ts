import { exceedsInlineTextBudget } from "@shared/input-semantics/resource-policy"

/** Image subtypes every supported provider accepts; `jpg` is only a file extension of `jpeg`. */
const PASTED_IMAGE_SUBTYPES = new Set(["png", "jpeg", "webp"])
const URL_ONLY_PATTERN = /^\S+:\/\/\S+$/

/** One clipboard entry, reduced to what the paste decision reads. */
export interface PasteClipboardItem {
	readonly type: string
	getAsFile(): File | null
}

/** What the composer is currently able to accept from a paste. */
export interface PasteCapacity {
	/** Files and images can be attached at all in this composer. */
	readonly attachmentsEnabled: boolean
	/** At least one attachment slot is still free. */
	readonly hasFreeSlot: boolean
}

/** Who handles one paste, decided before the browser applies its default. */
export type PasteIntent =
	| { readonly kind: "url"; readonly url: string }
	| { readonly kind: "oversized_text"; readonly text: string }
	| { readonly kind: "images"; readonly files: readonly File[] }
	| { readonly kind: "native" }

function pastedImages(items: readonly PasteClipboardItem[]): File[] {
	return items
		.filter((item) => {
			const [type, subtype] = item.type.split("/")
			return type === "image" && PASTED_IMAGE_SUBTYPES.has(subtype)
		})
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null)
}

/**
 * Decide synchronously how one paste is handled.
 *
 * The browser applies its default paste as soon as the event handler yields,
 * and the clipboard items become unreadable once dispatch ends. Every decision
 * to take the paste over - and every file it needs - therefore has to be made
 * here, before any asynchronous work starts; deciding after an `await` lets the
 * raw text land in the composer and loses the pasted images.
 */
export function classifyPaste(text: string, items: readonly PasteClipboardItem[], capacity: PasteCapacity): PasteIntent {
	const trimmed = text.trim()
	if (URL_ONLY_PATTERN.test(trimmed)) return { kind: "url", url: trimmed }
	if (capacity.attachmentsEnabled && capacity.hasFreeSlot && exceedsInlineTextBudget(text)) {
		return { kind: "oversized_text", text }
	}
	if (!capacity.attachmentsEnabled) return { kind: "native" }
	const files = pastedImages(items)
	return files.length > 0 ? { kind: "images", files } : { kind: "native" }
}
