export declare const FALLBACK_SOURCE_REF: string

export declare function resolveSourceRef(
	env: Record<string, string | undefined>,
	readGit: (args: string[]) => string | null,
): string

export declare function gitReader(cwd: string): (args: string[]) => string | null

export declare function readRepositoryWebUrl(packageJsonPath: string): string
