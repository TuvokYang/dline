import * as path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { resolveWorkspacePath } from "@core/workspace"
import { getReadablePath } from "@utils/path"
import { HostProvider } from "@/hosts/host-provider"
import { ClineDefaultTool } from "@/shared/tools"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { describeLanguageFailure } from "./language-tool-failure"

export class RenameSymbolHandler implements IFullyManagedTool {
    readonly name = ClineDefaultTool.RENAME

    getDescription(block: ToolUse): string {
        return `[rename] ${(block.params as any)?.new_name || "?"}`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const config = uiHelpers.getConfig()
        if (config.isSubagentExecution) return
        const params = block.params as Record<string, unknown> | undefined
        const rawPath = String(params?.file_path || "")
        const newName = String(params?.new_name || "")
        await uiHelpers.say(
            "tool",
            JSON.stringify({
                tool: "renameSymbol",
                path: getReadablePath(config.cwd, rawPath),
                regex: newName,
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
        const newName = String(p?.new_name || "")
        const dryRun = p?.dry_run === true || p?.dry_run === "true"
        const displayPath = getReadablePath(config.cwd, rawPath)
        const errMsg = (msg: string) => {
            config.callbacks
                .say(
                    "tool",
                    JSON.stringify({
                        tool: "renameSymbol",
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
        if (!rawPath || !line || !character || !newName) return errMsg(getPrompt("rename", "missingParams"))

        // The LSP requires an absolute path; the model may pass a workspace-relative one.
        const pathResult = resolveWorkspacePath(config, rawPath, "RenameSymbolHandler.execute")
        const filePath = typeof pathResult === "string" ? pathResult : pathResult.absolutePath

        try {
            const r = await HostProvider.language.renameSymbol({ filePath, line, character, newName, dryRun })
            const failure = describeLanguageFailure("rename", r, displayPath)
            if (failure) return errMsg(failure)
            if (!r.success) return errMsg(getPrompt("rename", "noEdits"))

            // Track all modified files for per-file checkpointing (non-dry-run only)
            if (!dryRun) {
                for (const file of r.preview || []) {
                    // Resolve to absolute path using workspace cwd as base, since
                    // LSP may return workspace-relative paths.
                    const absPath = path.resolve(config.cwd, file.filePath)
                    config.services.taskFileTracker.trackModification(absPath)
                }
            }

            const oldName = r.preview?.[0]?.edits?.[0]?.originalText || ""
            // Build structured match entries from LSP preview
            const matchEntries: Array<{
                file: string
                line: number
                column: number
                originalText: string
                newText: string
                diff: string
            }> = []
            for (const file of r.preview || []) {
                const rel = getReadablePath(config.cwd, file.filePath)
                for (const edit of file.edits) {
                    matchEntries.push({
                        file: rel,
                        line: edit.startLine,
                        column: edit.startCharacter,
                        originalText: edit.originalText || oldName,
                        newText: newName,
                        diff: `- ${edit.oldLine}\n+ ${edit.newLine}`,
                    })
                }
            }
            const diff = matchEntries.map((m) => m.diff).join("\n")
            const content = buildContent(config.cwd, oldName, newName, dryRun, r.filesChanged, r.totalChanges, r.preview)
            config.callbacks
                .say(
                    "tool",
                    JSON.stringify({
                        tool: "renameSymbol",
                        path: displayPath,
                        regex: newName,
                        diff,
                        matches: matchEntries,
                        files: r.filesChanged,
                        count: r.totalChanges,
                        dryRun,
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
            return errMsg(renderPrompt("rename", "errorPrefix", { ERROR: String(e) }))
        }
    }
}

function buildContent(
    cwd: string,
    oldName: string,
    newName: string,
    dryRun: boolean,
    filesChanged: number,
    totalChanges: number,
    preview?: Array<{
        filePath: string
        edits: Array<{ startLine: number; startCharacter: number; newText: string; originalText: string }>
    }>,
): string {
    let out = dryRun
        ? renderPrompt("rename", "dryRunHeader", {
              OLD_NAME: oldName,
              NEW_NAME: newName,
              FILES: filesChanged,
              CHANGES: totalChanges,
          })
        : renderPrompt("rename", "successOutput", {
              OLD_NAME: oldName,
              NEW_NAME: newName,
              FILES: filesChanged,
              CHANGES: totalChanges,
          })
    if (!preview) return out
    for (const file of preview) {
        const rel = getReadablePath(cwd, file.filePath)
        for (const edit of file.edits) {
            out += `${renderPrompt("rename", "fileEditLine", {
                FILE: rel,
                LINE: edit.startLine,
                CHARACTER: edit.startCharacter,
                ORIGINAL: edit.originalText || oldName,
                NEW: edit.newText,
            })}`
        }
    }
    if (dryRun) out += `\n${getPrompt("rename", "dryRunFooter")}`
    return out
}
