export type ChangelogLanguage = "english" | "chinese"

export type ChangelogSource = "current" | "history"

export interface ChangelogLanguageNotes {
    body: string
    sourcePath: string
    empty: boolean
}

export interface ChangelogNotes {
    version: string
    source: ChangelogSource
    anchor: string
    english: ChangelogLanguageNotes
    chinese: ChangelogLanguageNotes
}

export type PathPair = Record<ChangelogLanguage, string>
export declare const CHANGELOG_LANGUAGES: ChangelogLanguage[]
export declare const CURRENT_SOURCES: PathPair
export declare const HISTORY_SOURCES: PathPair
export declare function assertReleaseVersion(version: unknown): string
export declare function currentSourcePaths(): PathPair
export declare function readChangelog(request: {
    root: string
    version: string
    source?: ChangelogSource
    fileSystem?: unknown
}): ChangelogNotes
export declare function readCurrent(request: { root: string; fileSystem?: unknown }): ChangelogNotes
export declare function compareVersionsDescending(left: string, right: string): number
export declare function listHistoryVersions(request: { root: string; fileSystem?: unknown }): string[]
export declare function checkChangelogSet(request: { root: string; fileSystem?: unknown; manifestVersion?: string }): {
    version: string
    historyVersions: string[]
    currentFiles: string[]
}
