/**
 * Shell navigation chrome.
 *
 * The toolbar config keeps stable keys; labels are resolved while rendering so a
 * language switch never rebuilds the tab definitions or their handlers.
 */
export const en = {
    "shell.navigation.chat.name": "Chat",
    "shell.navigation.chat.tooltip": "New Task",
    "shell.navigation.mcp.name": "MCP",
    "shell.navigation.mcp.tooltip": "MCP Servers",
    "shell.navigation.history.name": "History",
    "shell.navigation.history.tooltip": "History",
    "shell.navigation.account.name": "Account",
    "shell.navigation.account.tooltip": "Account",
    "shell.navigation.settings.name": "Settings",
    "shell.navigation.settings.tooltip": "Settings",
} as const
