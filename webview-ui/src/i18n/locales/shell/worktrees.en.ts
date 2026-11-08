/**
 * Git worktree management: the view, its create/delete modals and the merge flow.
 *
 * Branch names, paths, conflicting file names and service error messages are
 * data. The "ask Dline to resolve" prompt is model input and stays in
 * `WorktreesView.tsx` untranslated.
 */
export const en = {
    "shell.worktrees.title": "Worktrees",
    "shell.worktrees.done": "Done",
    "shell.worktrees.description":
        "Git worktrees let you work on multiple branches at the same time, each in its own folder. Open worktrees in their own windows so Dline can work on multiple tasks in parallel.",
    "shell.worktrees.learnMore": "Learn more",

    "shell.worktrees.include.detected": ".worktreeinclude detected.",
    "shell.worktrees.include.tipLabel": "Tip:",
    "shell.worktrees.include.tip": ({
        label,
        includeFile,
        exampleDirectory,
    }: {
        label: string
        includeFile: string
        exampleDirectory: string
    }) =>
        `${label} Create a ${includeFile} file to automatically copy files like ${exampleDirectory} to new worktrees, so you don't have to reinstall dependencies.`,
    "shell.worktrees.include.createFromGitignore": "Create from .gitignore",
    "shell.worktrees.include.creating": "Creating...",

    "shell.worktrees.loading": "Loading...",
    "shell.worktrees.multiRoot.title": "Multi-folder workspace detected",
    "shell.worktrees.multiRoot.description":
        "Worktrees are not supported when multiple folders are open in the same workspace. Please open a single repository folder to use this feature.",
    "shell.worktrees.subfolder.title": "Subfolder of a git repository",
    "shell.worktrees.subfolder.description":
        "You have a subfolder open instead of the repository root. Please open the root folder to use worktrees:",
    "shell.worktrees.notGitRepo": "Worktrees require a git repository. Please initialize git to use worktrees.",
    "shell.worktrees.retry": "Retry",
    "shell.worktrees.empty": "No worktrees found.",
    "shell.worktrees.loadFailed": "Failed to load worktrees",
    "shell.worktrees.createIncludeFailed": "Failed to create .worktreeinclude",
    "shell.worktrees.deleteFailed": "Failed to delete worktree",
    "shell.worktrees.mergeFailed": "Failed to merge worktree",
    "shell.worktrees.askFailed": "Failed to create task for Dline",

    "shell.worktrees.badge.primary": "Primary",
    "shell.worktrees.badge.primaryHelp": "The original worktree where your .git directory lives.",
    "shell.worktrees.badge.current": "Current",
    "shell.worktrees.badge.currentHelp": "This is the worktree currently open in this window.",
    "shell.worktrees.badge.locked": "Locked",
    "shell.worktrees.branchDetached": "HEAD (detached)",
    "shell.worktrees.branchUnknown": "unknown",

    "shell.worktrees.action.openCurrent": "Open in current window",
    "shell.worktrees.action.openNew": "Open in new window",
    "shell.worktrees.action.mergeInto": ({ branch }: { branch: string }) => `Merge into ${branch}`,
    "shell.worktrees.action.delete": "Delete this worktree",
    "shell.worktrees.action.new": "New Worktree",

    "shell.worktrees.merge.title": "Merge Worktree",
    "shell.worktrees.merge.conflictsTitle": "Merge conflicts detected",
    "shell.worktrees.merge.conflictsList": "The following files have conflicts:",
    "shell.worktrees.merge.more": ({ count }: { count: number }) => `...and ${count} more`,
    "shell.worktrees.merge.askDline": "Ask Dline to Resolve",
    "shell.worktrees.merge.manual": "I'll Resolve Manually",
    "shell.worktrees.merge.description": ({ sourceBranch, targetBranch }: { sourceBranch: string; targetBranch: string }) =>
        `This will merge branch ${sourceBranch} into ${targetBranch}.`,
    "shell.worktrees.merge.deleteAfter": "Delete worktree after successful merge",
    "shell.worktrees.merge.cancel": "Cancel",
    "shell.worktrees.merge.merging": "Merging...",
    "shell.worktrees.merge.confirm": "Merge",

    "shell.worktrees.create.title": "Create New Worktree",
    "shell.worktrees.create.titleOpenAfter": "New Worktree",
    "shell.worktrees.create.description": "This will create a copy of your project on a new branch.",
    "shell.worktrees.create.descriptionOpenAfter":
        "This will create a copy of your project on a new branch and open in a separate window.",
    "shell.worktrees.create.includeMissing": "No .worktreeinclude detected.",
    "shell.worktrees.create.branchLabel": "Branch Name *",
    "shell.worktrees.create.branchPlaceholder": "feature/my-feature",
    "shell.worktrees.create.branchHelp": "Your new copy will be checked out to this branch.",
    "shell.worktrees.create.pathLabel": "Folder Path *",
    "shell.worktrees.create.pathPlaceholder": "../my-feature-worktree",
    "shell.worktrees.create.pathHelp": "Where the project will be copied for the worktree.",
    "shell.worktrees.create.clear": "Clear",
    "shell.worktrees.create.loadingDefaults": "Loading...",
    "shell.worktrees.create.creating": "Creating...",
    "shell.worktrees.create.creatingAndOpening": "Creating & Opening...",
    "shell.worktrees.create.submit": "Create Worktree",
    "shell.worktrees.create.submitAndOpen": "Create & Open",
    "shell.worktrees.create.failed": "Failed to create worktree",

    "shell.worktrees.delete.title": "Delete Worktree",
    "shell.worktrees.delete.description": ({ path }: { path: string }) => `This will delete the worktree directory at ${path}.`,
    "shell.worktrees.delete.alsoBranch": ({ branch }: { branch: string }) => `Also delete branch ${branch}`,
    "shell.worktrees.delete.warning": "Warning: Unpushed commits on this branch will be lost.",
    "shell.worktrees.delete.cancel": "Cancel",
    "shell.worktrees.delete.deleting": "Deleting...",
    "shell.worktrees.delete.confirm": "Delete",
} as const
