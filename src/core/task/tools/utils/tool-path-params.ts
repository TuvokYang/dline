import { ClineDefaultTool } from "@shared/tools"

/**
 * The file a block names, as its handler would read it.
 *
 * Two prompt profiles disagree about the parameter name: Standard declares
 * `absolutePath` for the file writers while the XML projection and every other
 * path-scoped tool use `path`. `WriteToFileToolHandler` accepts either, so a
 * caller that consults only one of them silently sees no path at all — and a
 * missing path is not neutral, because the approval gate reads it as "outside
 * the workspace" and the lane resolver reads it as "claims nothing".
 *
 * @param params Raw block parameters.
 * @returns The declared path, or undefined when the block names none.
 */
export function readToolPathParam(params: Record<string, string | undefined> | undefined): string | undefined {
	const candidate = params?.path ?? params?.absolutePath
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

/**
 * Tools whose declared path names a file they will modify.
 *
 * Only these contribute a write-path lane. A read-only tool also carries a
 * path, and treating it as a write would serialise reads of the same file for
 * no reason — and, worse, let an unrelated read block a real writer.
 *
 * `apply_patch`, `replace_text` and `rename` are deliberately absent: they
 * identify their targets through `input`, `file_pattern` and `file_path`
 * respectively, so no single declared path describes what they touch. They are
 * kept apart by the diff-editor lane they hold statically, not by path.
 */
const PATH_WRITING_TOOLS: ReadonlySet<string> = new Set<string>([
	ClineDefaultTool.FILE_NEW,
	ClineDefaultTool.FILE_EDIT,
	ClineDefaultTool.NEW_RULE,
])

/**
 * Whether a block's declared path is a write claim.
 *
 * @param toolName Registered tool identity.
 * @returns True when the tool's path names a file it will modify.
 */
export function declaresWritePath(toolName: string): boolean {
	return PATH_WRITING_TOOLS.has(toolName)
}
