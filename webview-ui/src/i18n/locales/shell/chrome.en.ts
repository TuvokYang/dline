/**
 * Shared shell chrome: view headers, hydration/error gates and reusable controls.
 *
 * Only product-owned wrappers live here. Rendered file paths, tool output, user
 * and model text stay outside this resource.
 */
export const en = {
    "shell.chrome.done": "Done",
    "shell.chrome.close": "Close",
    "shell.chrome.dismiss": "Dismiss",
    "shell.chrome.retry": "Retry",
    "shell.chrome.cancel": "Cancel",
    "shell.chrome.copy": "Copy",
    "shell.chrome.copied": "Copied",
    "shell.chrome.environment.production": "Production",
    "shell.chrome.environment.staging": "Staging",
    "shell.chrome.environment.local": "Local",
    "shell.chrome.environment.selfHosted": "Self-hosted",
    "shell.chrome.environmentSuffix": ({ environment }: { environment: string }) => `${environment} environment`,

    "shell.hydration.pending": "Loading Dline…",
    "shell.hydration.slow": "Still waiting for the extension to send its state. This is taking longer than usual.",
    "shell.hydration.failed": "Dline could not load its state.",

    "shell.errorBoundary.title": "Dline hit an error while rendering this panel.",
    "shell.errorBoundary.reload": "Reload panel",

    "shell.alert.unsavedTitle": "Unsaved Changes",
    "shell.alert.unsavedDescription": "You have unsaved changes. Are you sure you want to discard them?",
    "shell.alert.discard": "Discard Changes",
    "shell.alert.saveContinue": "Save & Continue",

    "shell.banner.region": "Announcements",
    "shell.banner.dismiss": "Dismiss banner",
    "shell.banner.previous": "Previous banner",
    "shell.banner.next": "Next banner",

    "shell.image.blocked": "External image blocked pending consent",
    "shell.image.sourceLabel": "Source:",
    "shell.image.altLabel": "Alt:",
    "shell.image.load": "Load image",

    "shell.mermaid.generating": "Generating mermaid diagram...",
    "shell.mermaid.copy": "Copy Code",
    "shell.latex.copy": "Copy LaTeX source",

    "shell.codeAccordian.expand": "Expand code block",
    "shell.codeAccordian.collapse": "Collapse code block",
    "shell.codeAccordian.userEdits": "User Edits",
    "shell.codeAccordian.consoleLogs": "Console Logs",

    "shell.markdown.copyCode": "Copy code",
    "shell.markdown.actMode.toggle": "Click to toggle to Act Mode",
    "shell.markdown.actMode.already": "Already in Act Mode",
    "shell.markdown.actMode.label": "Act Mode (⌘⇧A)",
    "shell.markdown.openInEditor": ({ path }: { path: string }) => `Open ${path} in editor`,

    "shell.openFileLink.aria": ({ name }: { name: string }) => `Open log file ${name}`,
    "shell.openFileLink.title": ({ path }: { path: string }) => `Click to open: ${path}`,

    "shell.checkpoint.compare": "Compare",
    "shell.checkpoint.restore": "Restore",
    "shell.checkpoint.restoreBoth": "Restore Task and Workspace",
    "shell.checkpoint.restoreBothHelp": "Restores the task and your project's files back to a snapshot taken at this point",
    "shell.checkpoint.restoreTask": "Restore Task Only",
    "shell.checkpoint.restoreTaskHelp": "Deletes messages after this point (does not affect workspace)",
    "shell.checkpoint.restoreWorkspace": "Restore Workspace Only",
    "shell.checkpoint.restoreWorkspaceHelp":
        "Restores your project's files to a snapshot taken at this point (task may become out of sync)",

    "shell.checkmark.label": "Checkpoint",
    "shell.checkmark.compaction": "Compaction checkpoint",
    "shell.checkmark.before": ({ tool }: { tool: string }) => `Before ${tool}`,
    "shell.checkmark.partialCoverage": ({
        label,
        available,
        total,
        restored,
    }: {
        label: string
        available: number
        total: number
        restored: boolean
    }) => `${label} (${available}/${total} workspaces${restored ? ", restored" : ""})`,
    "shell.checkmark.restored": ({ label }: { label: string }) => `${label} (restored)`,
    "shell.checkmark.restoreFilesTask": "Restore Files & Task",
    "shell.checkmark.restoreFilesTaskHelp": "Revert files and clear messages after this point",
    "shell.checkmark.moreOptions": "More options",
    "shell.checkmark.restoreFilesOnly": "Restore Files Only",
    "shell.checkmark.restoreFilesOnlyHelp": "Revert files to this checkpoint",
    "shell.checkmark.restoreTaskOnly": "Restore Task Only",
    "shell.checkmark.restoreTaskOnlyHelp": "Clear messages after this point",
    "shell.checkmark.compactionHelp":
        "Restore the conversation to the checkpoint before this Pass. Workspace files are unchanged.",
    "shell.checkmark.taskHelp": "Restore the conversation to this checkpoint. Workspace files are unchanged.",

    "shell.resourceChip.openHint": "Click to open.",

    "shell.metric.bar": "Bar chart",
    "shell.metric.line": "Line chart",
    "shell.metric.history": "Metrics history",
    "shell.metric.rpm": "Requests per minute",
    "shell.metric.tokens": "Token consumption",
    "shell.metric.tpm": "Tokens per minute",

    "shell.thumbnails.imageAlt": ({ index }: { index: number }) => `Thumbnail image-${index}`,
} as const
