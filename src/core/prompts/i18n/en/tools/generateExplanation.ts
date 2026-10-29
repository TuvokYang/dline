// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description:
        "Opens a multi-file diff view and generates AI-powered inline comments explaining the changes between two git references. Use this tool to help users understand code changes from git commits, pull requests, branches, or any git refs. The tool uses git to retrieve file contents and displays a side-by-side diff view with explanatory comments.",
    titleInstruction:
        "A descriptive title for the diff view (e.g., 'Changes in commit abc123', 'PR #42: Add authentication', 'Changes between main and feature-branch')",
    titleUsage: "Changes in last commit",
    fromRefInstruction:
        "The git reference for the 'before' state. Can be a commit hash, branch name, tag, or relative reference like HEAD~1, HEAD^, origin/main, etc.",
    fromRefUsage: "HEAD~1",
    toRefInstruction:
        "The git reference for the 'after' state. Can be a commit hash, branch name, tag, or relative reference. If not provided, compares to the current working directory (including uncommitted changes).",
    toRefUsage: "HEAD",
}
export default prompts
