/** Rolling section of a build that has no released version yet. */
export declare const UNRELEASED_SECTION: "Unreleased"

/** One parsed version section. */
export interface ParsedChangelogSection {
    version: string
    body: string
    empty: boolean
}

/** Normalize a stored changelog before parsing. */
export declare function normalizeChangelogText(source: string): string

/** Recognize a plain `major.minor.patch` release version. */
export declare function isReleaseVersion(value: unknown): boolean

/** GFM anchor of one version heading. */
export declare function sectionAnchor(version: string): string

/** Parse one changelog text into its version sections. */
export declare function parseChangelog(source: string, options?: { label?: string }): { sections: ParsedChangelogSection[] }

/** Select one section that must be usable. */
export declare function findSection(
    parsed: { sections: ParsedChangelogSection[] },
    version: string,
    options?: { allowEmpty?: boolean },
): ParsedChangelogSection

/** A single-section changelog document: one title and one version heading. */
export declare function renderSingleSection(version: string, body: string): string
