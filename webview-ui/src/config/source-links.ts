// Compile-time constants injected by vite.config.ts (and vitest.project.ts for tests).
declare const __DLINE_REPOSITORY_URL__: string
declare const __DLINE_SOURCE_REF__: string

/** Repository web URL declared by the root package manifest. */
export const DLINE_REPOSITORY_URL: string = __DLINE_REPOSITORY_URL__

/** Branch, tag, or commit this webview build was compiled from. */
export const DLINE_SOURCE_REF: string = __DLINE_SOURCE_REF__

/**
 * GitHub page of a repository file at the revision this build was compiled from,
 * so shipped links never show another branch's content.
 */
export function repositoryFileUrl(filePath: string): string {
	return `${DLINE_REPOSITORY_URL}/blob/${DLINE_SOURCE_REF}/${filePath.replace(/^\/+/, "")}`
}
