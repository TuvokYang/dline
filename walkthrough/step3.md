# Keep Side Effects Reviewable

Dline classifies tool requests by action type and the current approval settings. Workspace reads and safe commands can run automatically by default; edits and higher-impact actions normally request review unless you enable matching automation.

Approval never overrides workspace boundaries, `.agentignore`, host restrictions, or tool-specific safety checks. Command and subagent runs are retained in **Activities** with output and terminal state; other tool results remain in the task conversation.

[Review Dline Settings](command:dline.settingsButtonClicked) · [Read the auto-approval guide](https://docs.dline.cc/features/auto-approve/)
