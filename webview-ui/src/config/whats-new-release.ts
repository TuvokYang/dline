/**
 * One inline run of a What's New item. The set mirrors the Markdown subset the
 * build accepts, so the dialog never has to interpret raw Markdown.
 */
export type WhatsNewInline =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "strong"; readonly text: string }
	| { readonly kind: "code"; readonly text: string }
	| { readonly kind: "link"; readonly text: string; readonly href: string }

/** The newest release section of docs/whats-new/WHATS_NEW_en.md, parsed at build time. */
export interface WhatsNewRelease {
	readonly version: string
	readonly items: readonly (readonly WhatsNewInline[])[]
}
