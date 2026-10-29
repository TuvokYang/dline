import { McpHub } from "@services/mcp/McpHub"
import { RuntimePromptGenerator } from "./generators/RuntimePromptGenerator"
import { englishTemplateStore } from "./i18n/en"

const runtimeGenerator = new RuntimePromptGenerator(englishTemplateStore)

export async function loadMcpDocumentation(mcpHub: McpHub) {
    const mcpServersPath = await mcpHub.getMcpServersPath()
    const mcpSettingsFilePath = await mcpHub.getMcpSettingsFilePath()
    const connectedServers =
        mcpHub
            .getServers()
            .filter((server) => server.status === "connected")
            .map((server) => server.name)
            .join(", ") || runtimeGenerator.generate("loadMcpDocumentation.noneRunning", {}).text

    return `${
        runtimeGenerator.generate("loadMcpDocumentation.main", {
            MCP_SERVERS_PATH: mcpServersPath,
            MCP_SETTINGS_FILE_PATH: mcpSettingsFilePath,
            CONNECTED_SERVERS: connectedServers,
        }).text
    }\n`
}
