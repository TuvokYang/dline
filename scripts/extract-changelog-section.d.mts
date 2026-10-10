export interface ExtractChangelogSectionOptions {
	allowEmpty?: boolean
}

export function extractChangelogSection(source: string, version: string, options?: ExtractChangelogSectionOptions): string
