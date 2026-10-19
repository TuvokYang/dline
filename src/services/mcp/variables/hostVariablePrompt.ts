import { HostProvider } from "@/hosts/host-provider"
import type { McpVariablePrompt } from "./McpVariableResolver"

/** Ask for one MCP variable in a masked host input box that survives focus changes. */
export const promptForMcpVariable: McpVariablePrompt = async ({ serverLabel, variable }) => {
    const { response } = await HostProvider.window.showInputBox({
        title: `MCP server "${serverLabel}" needs ${variable}`,
        prompt: `Enter the value for \${env:${variable}}. It is saved for this server only. Cancel to leave the server disconnected.`,
        password: true,
        ignoreFocusOut: true,
    })
    return response
}
