import { ActionMetadata } from "./types"

export const ACTION_METADATA: ActionMetadata[] = [
    {
        id: "readFiles",
        label: "Read project files",
        shortName: "Read",
        icon: "codicon-search",
        subAction: {
            id: "readFilesExternally",
            label: "Read all files",
            shortName: "Read (all)",
            icon: "codicon-folder-opened",
            parentActionId: "readFiles",
        },
    },
    {
        id: "editFiles",
        label: "Edit project files",
        shortName: "Edit",
        icon: "codicon-edit",
        subAction: {
            id: "editFilesExternally",
            label: "Edit all files",
            shortName: "Edit (all)",
            icon: "codicon-files",
            parentActionId: "editFiles",
        },
    },
    {
        id: "executeSafeCommands",
        label: "Execute safe commands",
        shortName: "Safe Commands",
        icon: "codicon-terminal",
        subAction: {
            id: "executeAllCommands",
            label: "Execute all commands",
            shortName: "All Commands",
            icon: "codicon-terminal-bash",
            parentActionId: "executeSafeCommands",
        },
    },
    {
        id: "useBrowser",
        label: "Use the browser",
        shortName: "Browser",
        icon: "codicon-browser",
    },
    {
        id: "useWeb",
        label: "Use Web",
        shortName: "Web",
        icon: "codicon-globe",
    },
    {
        id: "useMcp",
        label: "Use MCP servers",
        shortName: "MCP",
        icon: "codicon-server",
    },
    {
        id: "generateImages",
        label: "Generate images",
        shortName: "Images",
        icon: "codicon-device-camera",
    },
    {
        id: "focusChain",
        label: "Focus chain overrides",
        shortName: "Focus Chain",
        icon: "codicon-checklist",
    },
]

export const NOTIFICATIONS_SETTING: ActionMetadata = {
    id: "enableNotifications",
    label: "Enable notifications",
    shortName: "Notifications",
    icon: "codicon-bell",
}
