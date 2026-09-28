import path from "node:path"
import { ClineDefaultTool } from "@shared/tools"

export type ToolPathParamName = "path" | "absolutePath"

export interface ToolPathParam {
	name: ToolPathParamName
	value: string
	legacy: boolean
}

export interface ToolPathParamResolution {
	param?: ToolPathParam
	error?: string
}

/** Return whether a raw tool value contains non-whitespace content. */
function hasPathValue(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0
}

/** Strip the optional multi-root selector before validating the declared path. */
function pathWithoutWorkspaceHint(value: string): string {
	const match = value.match(/^@[^:]+:([\s\S]*)$/)
	return match?.[1] ?? value
}

/** Recognize POSIX, Windows drive-letter, and UNC absolute paths on every host OS. */
function isAbsolutePathInput(value: string): boolean {
	const candidate = pathWithoutWorkspaceHint(value)
	return path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
}

/**
 * Resolve the public relative `path` parameter or the legacy `absolutePath` alias.
 *
 * New tool calls must use one workspace-relative `path`. The legacy alias remains
 * readable so frozen schemas and persisted tasks can resume, but it is never
 * advertised. Rejecting dual declarations keeps approval scope and execution on
 * the same target instead of silently preferring one parameter at each boundary.
 */
export function resolveToolPathParam(params: Record<string, string | undefined> | undefined): ToolPathParamResolution {
	const relativePath = params?.path
	const legacyAbsolutePath = params?.absolutePath
	const hasRelativePath = hasPathValue(relativePath)
	const hasLegacyPath = hasPathValue(legacyAbsolutePath)

	if (hasRelativePath && hasLegacyPath) {
		return { error: "Parameters 'path' and legacy 'absolutePath' cannot be used together." }
	}

	if (hasRelativePath) {
		if (isAbsolutePathInput(relativePath)) {
			return {
				error: "Parameter 'path' must be relative to a workspace. Use @<workspace-name>:<relative-path> for another workspace or '..' segments for an authorized external target.",
			}
		}
		return { param: { name: "path", value: relativePath, legacy: false } }
	}

	if (hasLegacyPath) {
		return { param: { name: "absolutePath", value: legacyAbsolutePath, legacy: true } }
	}

	return {}
}

/** The path value a writer will execute against, when the declaration is valid. */
export function readToolPathParam(params: Record<string, string | undefined> | undefined): string | undefined {
	return resolveToolPathParam(params).param?.value
}

/** Tools whose declared path names a file they will modify. */
const PATH_WRITING_TOOLS: ReadonlySet<string> = new Set<string>([
	ClineDefaultTool.FILE_NEW,
	ClineDefaultTool.FILE_EDIT,
	ClineDefaultTool.NEW_RULE,
])

/** Whether a block's declared path is a write claim. */
export function declaresWritePath(toolName: string): boolean {
	return PATH_WRITING_TOOLS.has(toolName)
}
