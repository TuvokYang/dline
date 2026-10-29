import { diagnosticsToProblemsString } from "@integrations/diagnostics"
import { extractTextFromFile } from "@integrations/misc/extract-text"
import { openFile } from "@integrations/misc/open-file"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { telemetryService } from "@services/telemetry"
import type { MentionReference } from "@shared/input-semantics/mention-reference"
import { WorkspaceRoot } from "@shared/multi-root/types"
import { openExternal } from "@utils/env"
import { getCommitInfo, getWorkingState } from "@utils/git"
import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getLatestTerminalOutput } from "@/hosts/vscode/terminal/get-latest-output"
import { DiagnosticSeverity } from "@/shared/proto/dline"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { isDirectory } from "@/utils/fs"
import { getCwd } from "@/utils/path"
import { FileContextTracker } from "../context/context-tracking/FileContextTracker"
import type { WorkspaceRootManager } from "../workspace"

export interface MentionPathAccessPolicy {
    validateFileAccess(filePath: string, baseDir: string): boolean
    validateDirectoryAccess(directoryPath: string, baseDir: string): boolean
}

export async function openMention(mention?: string): Promise<void> {
    if (!mention) {
        return
    }

    const cwd = await getCwd()
    if (!cwd) {
        return
    }

    if (isFileMention(mention)) {
        const relPath = getFilePathFromMention(mention)
        const absPath = path.resolve(cwd, relPath)
        if (await isDirectory(absPath)) {
            await HostProvider.workspace.openInFileExplorerPanel({ path: absPath })
        } else {
            openFile(absPath)
        }
    } else if (mention === "problems") {
        await HostProvider.workspace.openProblemsPanel({})
    } else if (mention === "terminal") {
        await HostProvider.workspace.openTerminalPanel({})
    } else if (mention.startsWith("http")) {
        await openExternal(mention)
    }
}

export async function getFileMentionFromPath(filePath: string) {
    const cwd = await getCwd()
    if (!cwd) {
        return `@/${filePath}`
    }
    const relativePath = path.relative(cwd, filePath)
    return `@/${relativePath}`
}

/** What resolving a mention may read, and the policy that bounds it. */
export interface MentionResolutionEnvironment {
    readonly cwd: string
    readonly urlContentFetcher: UrlContentFetcher
    readonly fileContextTracker?: FileContextTracker
    readonly workspaceManager?: WorkspaceRootManager
    readonly pathAccessPolicy?: MentionPathAccessPolicy
}

type MentionFailureType = "not_found" | "permission_denied" | "unknown"

/**
 * Resolve one mention the user already chose into the text Core sends in its place.
 *
 * The result is a short inline label - so the sentence the mention sits in still
 * reads naturally - followed by the content it names. The mention arrives typed,
 * so nothing here reads surrounding text or discovers a second mention.
 */
export async function resolveMention(reference: MentionReference, environment: MentionResolutionEnvironment): Promise<string> {
    const label = mentionLabel(reference)
    const content = await mentionContent(reference, environment)
    return content === undefined ? label : `${label}\n\n${content}`
}

/** A path reference relative to its workspace root, the way tool calls spell paths. */
function relativeMentionPath(reference: MentionReference): string {
    return reference.ref.startsWith("/") ? reference.ref.slice(1) : reference.ref
}

function mentionLabel(reference: MentionReference): string {
    switch (reference.kind) {
        case "url":
            return `'${reference.ref}' (see below for site content)`
        case "file":
        case "folder": {
            const mentionPath = relativeMentionPath(reference)
            // A workspace-prefixed mention keeps its workspace in the same form the model uses for tool calls.
            const shown = reference.workspaceHint ? `${reference.workspaceHint}:${mentionPath}` : mentionPath
            return `'${shown}' (see below for ${reference.kind} content)`
        }
        case "problems":
            return "Workspace Problems (see below for diagnostics)"
        case "terminal":
            return "Terminal Output (see below for output)"
        case "git_changes":
            return "Working directory changes (see below for details)"
        case "git_commit":
            return `Git commit '${reference.ref}' (see below for commit info)`
    }
}

async function mentionContent(
    reference: MentionReference,
    environment: MentionResolutionEnvironment,
): Promise<string | undefined> {
    switch (reference.kind) {
        case "url":
            return urlContent(reference.ref, environment.urlContentFetcher)
        case "file":
        case "folder":
            // A bare root would expand the whole workspace: it would inflate the
            // context and can recurse. Root expansion needs its own explicit syntax.
            if (reference.ref === "/") return undefined
            return pathContent(reference, environment)
        case "problems":
            return capturedContent("problems", "workspace_diagnostics", "Error fetching diagnostics", getWorkspaceProblems)
        case "terminal":
            return capturedContent("terminal", "terminal_output", "Error fetching terminal output", getLatestTerminalOutput)
        case "git_changes":
            return capturedContent("git-changes", "git_working_state", "Error fetching working state", () =>
                getWorkingState(environment.cwd),
            )
        case "git_commit":
            return capturedContent(
                "commit",
                `git_commit hash="${reference.ref}"`,
                "Error fetching commit info",
                () => getCommitInfo(reference.ref, environment.cwd),
                "git_commit",
            )
    }
}

/** Read one piece of workspace state into its tag, recording the outcome either way. */
async function capturedContent(
    telemetryKind: "problems" | "terminal" | "git-changes" | "commit",
    openTag: string,
    errorPrefix: string,
    read: () => Promise<string>,
    closeTag = openTag,
): Promise<string> {
    try {
        const content = await read()
        telemetryService.captureMentionUsed(telemetryKind, content.length)
        return `<${openTag}>\n${content}\n</${closeTag}>`
    } catch (error) {
        const message = errorMessageOf(error)
        telemetryService.captureMentionFailed(telemetryKind, "unknown", message)
        return `<${openTag}>\n${errorPrefix}: ${message}\n</${closeTag}>`
    }
}

async function urlContent(url: string, fetcher: UrlContentFetcher): Promise<string> {
    let result: string
    try {
        await fetcher.launchBrowser()
        try {
            const markdown = await fetcher.urlToMarkdown(url)
            telemetryService.captureMentionUsed("url", markdown.length)
            result = markdown
        } finally {
            await fetcher.closeBrowser().catch((error: unknown) => {
                Logger.error(`Error closing browser: ${errorMessageOf(error)}`)
            })
        }
    } catch (error) {
        const message = errorMessageOf(error)
        HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: `Error fetching content for ${url}: ${message}` })
        telemetryService.captureMentionFailed("url", "network_error", message)
        result = `Error fetching content: ${message}`
    }
    return `<url_content url="${url}">\n${result}\n</url_content>`
}

/** One `<file_content>` or `<folder_content>` block, attributed to a workspace when there is more than one. */
function pathBlock(reference: MentionReference, body: string, workspace?: string): string {
    const tag = reference.kind === "folder" ? "folder_content" : "file_content"
    const attribution = workspace === undefined ? "" : ` workspace="${workspace}"`
    return `<${tag} path="${relativeMentionPath(reference)}"${attribution}>\n${body}\n</${tag}>`
}

function failureTypeOf(message: string): MentionFailureType {
    if (message.includes("ENOENT") || message.includes("Failed to access")) return "not_found"
    if (message.includes("EACCES") || message.includes("permission")) return "permission_denied"
    return "unknown"
}

async function pathContent(reference: MentionReference, environment: MentionResolutionEnvironment): Promise<string> {
    const { workspaceManager, pathAccessPolicy } = environment
    const mentionPath = relativeMentionPath(reference)
    const mentionType = reference.kind === "folder" ? "folder" : "file"
    const roots = workspaceManager?.getRoots() ?? []

    // A workspace-prefixed mention reads only the root it names.
    if (roots.length > 1 && reference.workspaceHint) {
        const targetRoot = workspaceManager?.getRootByName(reference.workspaceHint)
        if (!targetRoot) {
            const message = `Workspace '${reference.workspaceHint}' not found`
            telemetryService.captureMentionFailed(mentionType, "not_found", message)
            return pathBlock(reference, `Error fetching content: ${message}`, reference.workspaceHint)
        }
        return readPathMention(reference, targetRoot.path, environment, reference.workspaceHint)
    }

    // An unprefixed mention in a multi-root workspace is searched in every root.
    if (roots.length > 1) {
        const results = await Promise.all(
            roots.map(async (root: WorkspaceRoot) => {
                const workspaceName = root.name || path.basename(root.path)
                try {
                    return { workspaceName, content: await getFileOrFolderContent(mentionPath, root.path, pathAccessPolicy) }
                } catch {
                    return { workspaceName, content: undefined }
                }
            }),
        )
        const found = results.filter((result): result is { workspaceName: string; content: string } => !!result.content)
        if (found.length === 0) {
            const message = `File not found in any workspace. Searched: ${results.map((result) => result.workspaceName).join(", ")}`
            telemetryService.captureMentionFailed(mentionType, "not_found", message)
            return pathBlock(reference, `Error fetching content: ${message}`)
        }
        if (found.length === 1 && reference.kind === "file") {
            await environment.fileContextTracker?.trackFileContext(mentionPath, "file_mentioned")
        }
        telemetryService.captureMentionUsed(
            mentionType,
            found.reduce((sum, result) => sum + result.content.length, 0),
        )
        return found.map((result) => pathBlock(reference, result.content, result.workspaceName)).join("\n\n")
    }

    return readPathMention(reference, environment.cwd, environment)
}

async function readPathMention(
    reference: MentionReference,
    root: string,
    environment: MentionResolutionEnvironment,
    workspace?: string,
): Promise<string> {
    const mentionPath = relativeMentionPath(reference)
    const mentionType = reference.kind === "folder" ? "folder" : "file"
    try {
        const content = await getFileOrFolderContent(mentionPath, root, environment.pathAccessPolicy)
        if (reference.kind === "file") {
            await environment.fileContextTracker?.trackFileContext(mentionPath, "file_mentioned")
        }
        telemetryService.captureMentionUsed(mentionType, content.length)
        return pathBlock(reference, content, workspace)
    } catch (error) {
        const message = errorMessageOf(error)
        telemetryService.captureMentionFailed(mentionType, failureTypeOf(message), message)
        return pathBlock(reference, `Error fetching content: ${message}`, workspace)
    }
}

function errorMessageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function getFileOrFolderContent(
    mentionPath: string,
    cwd: string,
    pathAccessPolicy?: MentionPathAccessPolicy,
): Promise<string> {
    const workspaceRoot = path.resolve(cwd)
    const absPath = path.resolve(workspaceRoot, mentionPath)

    try {
        assertPathWithinWorkspace(mentionPath, workspaceRoot, absPath)
        if (pathAccessPolicy) {
            const allowed = mentionPath.endsWith("/")
                ? pathAccessPolicy.validateDirectoryAccess(mentionPath, cwd)
                : pathAccessPolicy.validateFileAccess(mentionPath, cwd)
            if (!allowed) throw new Error(`Access denied by workspace policy: "${mentionPath}"`)
        }
        const stats = await fs.stat(absPath)
        const [canonicalRoot, canonicalPath] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(absPath)])
        assertPathWithinWorkspace(mentionPath, canonicalRoot, canonicalPath)

        if (stats.isFile()) {
            const isBinary = await isBinaryFile(absPath).catch(() => false)
            if (isBinary) {
                return "(Binary file, unable to display content)"
            }
            const content = await extractTextFromFile(absPath)
            return content
        }
        if (stats.isDirectory()) {
            const entries = await fs.readdir(absPath, { withFileTypes: true })
            let folderContent = ""
            const fileContentPromises: Promise<string | undefined>[] = []
            entries.forEach((entry, index) => {
                const isLast = index === entries.length - 1
                const linePrefix = isLast ? "└── " : "├── "
                if (entry.isFile()) {
                    folderContent += `${linePrefix}${entry.name}\n`
                    const filePath = path.join(mentionPath, entry.name)
                    const absoluteFilePath = path.resolve(absPath, entry.name)
                    // const relativeFilePath = path.relative(cwd, absoluteFilePath);
                    fileContentPromises.push(
                        (async () => {
                            try {
                                if (pathAccessPolicy && !pathAccessPolicy.validateFileAccess(filePath, cwd)) return undefined
                                const canonicalFilePath = await fs.realpath(absoluteFilePath)
                                assertPathWithinWorkspace(filePath, canonicalRoot, canonicalFilePath)
                                const isBinary = await isBinaryFile(absoluteFilePath).catch(() => false)
                                if (isBinary) {
                                    return undefined
                                }
                                const content = await extractTextFromFile(absoluteFilePath)
                                return `<file_content path="${filePath.toPosix()}">\n${content}\n</file_content>`
                            } catch (_error) {
                                return undefined
                            }
                        })(),
                    )
                } else if (entry.isDirectory()) {
                    folderContent += `${linePrefix}${entry.name}/\n`
                    // not recursively getting folder contents
                } else {
                    folderContent += `${linePrefix}${entry.name}\n`
                }
            })
            const fileContents = (await Promise.all(fileContentPromises)).filter((content) => content)
            return `${folderContent}\n${fileContents.join("\n\n")}`.trim()
        }
        return `(Failed to read contents of ${mentionPath})`
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Access denied")) throw error
        throw new Error(`Failed to access path "${mentionPath}": ${error.message}`)
    }
}

function assertPathWithinWorkspace(mentionPath: string, workspaceRoot: string, candidatePath: string): void {
    const relativePath = path.relative(workspaceRoot, candidatePath)
    const outsideWorkspace = relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)
    if (outsideWorkspace) {
        throw new Error(`Access denied: path "${mentionPath}" is outside the workspace`)
    }
}

async function getWorkspaceProblems(): Promise<string> {
    const response = await HostProvider.workspace.getDiagnostics({})
    if (response.fileDiagnostics.length === 0) {
        return "No errors or warnings detected."
    }
    return diagnosticsToProblemsString(response.fileDiagnostics, [
        DiagnosticSeverity.DIAGNOSTIC_ERROR,
        DiagnosticSeverity.DIAGNOSTIC_WARNING,
    ])
}

/**
 * Parse a workspace mention to extract workspace hint and path
 * @param mention The raw mention string (e.g., "workspace:name/path/to/file")
 * @returns Object with workspaceHint and path, or null if not a workspace mention
 */
function parseWorkspaceMention(mention: string): { workspaceHint: string; path: string } | null {
    // Match workspace:name/path or workspace:"name/path with spaces"
    const workspaceMatch = mention.match(/^([\w-]+):(.+)$/)
    if (!workspaceMatch) {
        return null
    }

    const [, workspaceHint, pathPart] = workspaceMatch

    // Check if it's actually a URL (has ://)
    if (mention.includes("://")) {
        return null
    }

    // Remove quotes from path if present
    const quotedPathMatch = pathPart.match(/^"(.*)"$/)
    const cleanPath = quotedPathMatch ? quotedPathMatch[1] : pathPart

    return { workspaceHint, path: cleanPath }
}

function isFileMention(mention: string): boolean {
    // Check for workspace-prefixed mentions first
    if (parseWorkspaceMention(mention)) {
        return true
    }
    // Check for regular file mentions
    return mention.startsWith("/") || mention.startsWith('"/')
}

function getFilePathFromMention(mention: string): string {
    // Check for workspace-prefixed mentions first
    const workspaceMention = parseWorkspaceMention(mention)
    if (workspaceMention) {
        // Return path without leading slash (already cleaned)
        return workspaceMention.path.startsWith("/") ? workspaceMention.path.slice(1) : workspaceMention.path
    }

    // Remove quotes
    const match = mention.match(/^"(.*)"$/)
    const filePath = match ? match[1] : mention
    // Remove leading slash
    return filePath.slice(1)
}
