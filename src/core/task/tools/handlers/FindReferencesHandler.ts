import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { resolveWorkspacePath } from "@core/workspace"
import { getReadablePath } from "@utils/path"
import { HostProvider } from "@/hosts/host-provider"
import { DlineDefaultTool } from "@/shared/tools"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { describeLanguageFailure } from "./language-tool-failure"

/** Structured reference entry for JSON payload. */
interface RefEntry {
    file: string
    line: number
    character: number
    context: string
}

export class FindReferencesHandler implements IFullyManagedTool {
    readonly name = DlineDefaultTool.FIND_REFERENCES

    getDescription(block: ToolUse): string {
        const params = block.params as Record<string, unknown> | undefined
        return `[find_references] ${String(params?.file_path || "?")}`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const config = uiHelpers.getConfig()
        if (config.isSubagentExecution) return
        const params = block.params as Record<string, unknown> | undefined
        const rawPath = String(params?.file_path || "")
        await uiHelpers.say(
            "tool",
            JSON.stringify({
                tool: "findReferences",
                path: getReadablePath(config.cwd, rawPath),
                operationIsLocatedInWorkspace: true,
            }),
            undefined,
            undefined,
            true,
            block.ts,
        )
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
        const p = block.params as Record<string, unknown> | undefined
        const rawPath = String(p?.file_path || "")
        const line = Number(p?.line || 0)
        const character = Number(p?.character || 0)
        const displayPath = getReadablePath(config.cwd, rawPath)
        const errMsg = (msg: string) => {
            config.callbacks
                .say(
                    "tool",
                    JSON.stringify({
                        tool: "findReferences",
                        path: displayPath,
                        content: msg,
                        operationIsLocatedInWorkspace: true,
                    }),
                    undefined,
                    undefined,
                    false,
                    block.ts,
                )
                .catch(() => {})
            return msg
        }
        if (!rawPath || !line || !character) return errMsg("Error: missing required parameters.")

        // The LSP requires an absolute path; the model may pass a workspace-relative one.
        const pathResult = resolveWorkspacePath(config, rawPath, "FindReferencesHandler.execute")
        const filePath = typeof pathResult === "string" ? pathResult : pathResult.absolutePath

        try {
            const r = await HostProvider.language.findReferences({ filePath, line, character })
            const failure = describeLanguageFailure("findReferences", r, displayPath)
            if (failure) return errMsg(failure)
            if (!r.references?.length) return errMsg(getPrompt("findReferences", "noReferences"))

            // Build structured references array
            const refs: RefEntry[] = r.references.map((ref: any) => ({
                file: getReadablePath(config.cwd, ref.filePath),
                line: ref.startLine,
                character: ref.startCharacter,
                context: ref.contextLine,
            }))

            // Infer the symbol from the first reference's own column, not the start of its line.
            const firstRef = r.references[0]
            const symbolName = extractSymbolAt(firstRef.contextLine, firstRef.startCharacter)

            // Build human-readable content
            const grouped = new Map<string, string[]>()
            for (const ref of r.references) {
                const rel = getReadablePath(config.cwd, ref.filePath)
                if (!grouped.has(rel)) grouped.set(rel, [])
                grouped.get(rel)?.push(`L${ref.startLine}:${ref.startCharacter}  ${ref.contextLine}`)
            }
            const parts: string[] = []
            for (const [rel, lines] of grouped) parts.push(`${rel}\n${lines.join("\n")}`)
            const content = parts.join("\n\n")

            const uniqueFiles = new Set(r.references.map((ref: any) => ref.filePath)).size
            config.callbacks
                .say(
                    "tool",
                    JSON.stringify({
                        tool: "findReferences",
                        path: displayPath,
                        symbolName,
                        files: uniqueFiles,
                        count: r.references.length,
                        references: refs,
                        content,
                        operationIsLocatedInWorkspace: true,
                    }),
                    undefined,
                    undefined,
                    false,
                    block.ts,
                )
                .catch(() => {})
            return content
        } catch (e) {
            return errMsg(renderPrompt("findReferences", "errorPrefix", { ERROR: String(e) }))
        }
    }
}

/**
 * Extract a symbol name from a context line at the given 1-based character offset.
 * Returns the word starting at that position, or empty string if not found.
 *
 * The host reports 1-based columns (see hosts/vscode/hostbridge/language/findReferences.ts),
 * so callers pass ReferenceLocation.startCharacter unchanged.
 */
export function extractSymbolAt(contextLine: string, character: number): string {
    const idx = character - 1
    if (idx < 0 || idx >= contextLine.length) return ""
    const substr = contextLine.substring(idx)
    const match = substr.match(/^(\w+)/)
    return match ? match[1] : ""
}
