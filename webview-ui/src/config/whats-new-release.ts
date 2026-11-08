import type { UiLanguage } from "../../../src/shared/UiLanguage"

/**
 * One inline run of a What's New item. The set mirrors the Markdown subset the
 * build accepts, so the dialog never has to interpret raw Markdown.
 */
export type WhatsNewInline =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "strong"; readonly text: string }
    | { readonly kind: "code"; readonly text: string }
    | { readonly kind: "link"; readonly text: string; readonly href: string }

/** The newest release section of a What's New edition, parsed at build time. */
export interface WhatsNewRelease {
    readonly version: string
    readonly items: readonly (readonly WhatsNewInline[])[]
}

/** Display editions, never separate release or acknowledgment identities. */
export type WhatsNewEditions = Readonly<Record<UiLanguage, WhatsNewRelease>>
