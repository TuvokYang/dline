// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description:
        "Request to use a tool provided by a connected MCP server. Each MCP server can provide multiple tools with different capabilities. Tools have defined input schemas that specify required and optional parameters.",
    serverNameInstruction: "The name of the MCP server providing the tool",
    serverNameUsage: "server name here",
    toolNameInstruction: "The name of the tool to execute",
    toolNameUsage: "tool name here",
    argumentsInstruction: "A JSON object containing the tool's input parameters, following the tool's input schema",
    argumentsUsage: `
{
  "param1": "value1",
  "param2": "value2"
}
`,
    invalidMcpToolArgumentError:
        "Invalid JSON argument used with @SERVER_NAME@ for @TOOL_NAME@. Please retry with a properly formatted JSON argument.",
}
export default prompts
