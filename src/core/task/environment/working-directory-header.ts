/**
 * The environment-details header that names a task's working directory.
 *
 * The header is written into the first user message of every task, which makes
 * it the one durable record of the workspace a task ran in when its history
 * entry is lost. Its producer and its reader live together so the format has a
 * single owner.
 */

const MULTI_ROOT_PREFIX = "Primary: "
const WORKING_DIRECTORY_HEADER = /^# Current Working Directory \((.+)\) Files$/m

/** Header for a single-root workspace, naming the working directory itself. */
export function formatWorkingDirectoryHeader(cwdPosixPath: string): string {
    return `\n\n# Current Working Directory (${cwdPosixPath}) Files\n`
}

/** Header for a multi-root workspace, naming only the primary root. */
export function formatMultiRootWorkingDirectoryHeader(primaryName: string): string {
    return `\n\n# Current Working Directory (${MULTI_ROOT_PREFIX}${primaryName}) Files\n`
}

/**
 * Read the working directory a single-root header names.
 *
 * @returns The directory as written, or undefined when the text carries no
 *          header or only names a multi-root primary, which is not a path.
 */
export function readWorkingDirectoryHeader(text: string): string | undefined {
    const named = WORKING_DIRECTORY_HEADER.exec(text)?.[1]
    if (!named || named.startsWith(MULTI_ROOT_PREFIX)) return undefined
    return named
}
