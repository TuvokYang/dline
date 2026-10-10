import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

/**
 * A host-backed implementation of DiffViewProvider that keeps edits in memory until save.
 * Saving goes through the HostBridge document boundary so the host can preserve editor
 * history without opening a tab or changing focus.
 *
 * Visual operations like scrolling are implemented as no-ops since there is no UI component.
 * This makes it suitable for headless or non-interactive environments.
 */
export class FileEditProvider extends DiffViewProvider {
    protected documentContent?: string

    override showFile(_absolutePath: string): Promise<void> {
        // No-op: No visual editor to show the file
        return Promise.resolve()
    }

    protected async openDiffEditor(): Promise<void> {
        // No-op: No visual editor to open in a file-system-only provider
        // The file content is already loaded in the base class's open() method
        this.documentContent = this.originalContent || ""
    }

    override async open(relPath: string, options?: { displayPath?: string }): Promise<void> {
        await super.open(relPath, options)
        this.documentContent = this.originalContent || ""
    }

    async replaceText(
        content: string,
        rangeToReplace: { startLine: number; endLine: number },
        _currentLine: number | undefined,
    ): Promise<void> {
        if (this.documentContent === undefined) {
            Logger.warn(
                `FileEditProvider.replaceText: documentContent is undefined, isEditing=${this.isEditing}, absolutePath=${this.absolutePath}, originalContent=${this.originalContent ? "present" : "undefined"}`,
            )
            // Auto-recover: if originalContent was loaded during open(), reuse it.
            // This prevents "Document not initialized" when reset() was called
            // between open() and update() (e.g. after a diff-match failure).
            if (this.originalContent !== undefined) {
                this.documentContent = this.originalContent
            } else {
                throw new Error("Document not initialized")
            }
        }

        // Split the document into lines
        const lines = this.documentContent.split("\n")

        // Check if we're replacing to the end of the document
        const replacingToEnd = rangeToReplace.endLine >= lines.length

        // Replace the specified range with the new content
        const newContentLines = content.split("\n")

        // Remove trailing empty line for proper splicing, BUT only when NOT replacing
        // to the end of the document. When replacing to the end, keep the trailing
        // empty string to preserve trailing newlines from the content.
        if (!replacingToEnd && newContentLines[newContentLines.length - 1] === "") {
            newContentLines.pop()
        }

        // Splice the lines array to replace the range
        lines.splice(rangeToReplace.startLine, rangeToReplace.endLine - rangeToReplace.startLine, ...newContentLines)

        // Join the lines back together
        this.documentContent = lines.join("\n")
    }

    protected async scrollEditorToLine(_line: number): Promise<void> {
        // No-op: No visual editor to scroll
    }

    protected async scrollAnimation(_startLine: number, _endLine: number): Promise<void> {
        // No-op: No visual editor to animate
    }

    protected async truncateDocument(lineNumber: number): Promise<void> {
        if (!this.documentContent) {
            return
        }

        // Split the document into lines and keep only up to lineNumber
        const lines = this.documentContent.split("\n")
        if (lineNumber < lines.length) {
            this.documentContent = lines.slice(0, lineNumber).join("\n")
        }
    }

    protected async getDocumentLineCount(): Promise<number> {
        if (!this.documentContent) {
            return 0
        }
        return this.documentContent.split("\n").length
    }

    protected async getDocumentText(): Promise<string | undefined> {
        return this.documentContent
    }

    /**
     * Public method to get the current document content.
     * This is exposed for use by tools that need to read the document state.
     */
    public async getContent(): Promise<string | undefined> {
        return this.getDocumentText()
    }

    protected override async saveDocument(): Promise<boolean> {
        if (!this.absolutePath || this.documentContent === undefined) {
            return false
        }

        try {
            const result = await HostProvider.workspace.applyTextDocumentEdit({
                filePath: this.absolutePath,
                expectedContent: this.originalContent ?? "",
                content: this.documentContent,
            })
            if (result.conflict) {
                throw new Error(`Document changed after the background edit started: ${this.absolutePath}`)
            }
            if (result.saved) this.documentContent = result.content
            return result.saved
        } catch (error) {
            Logger.error(`Failed to save document through the host: ${this.absolutePath}:`, error)
            return false
        }
    }

    protected async closeAllDiffViews(): Promise<void> {
        // No-op: No visual diff views to close
    }

    protected async resetDiffView(): Promise<void> {
        // Clean up the in-memory document content
        this.documentContent = undefined
    }
}
