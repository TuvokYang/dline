// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description:
        "Request to access a resource provided by a connected MCP server. Resources represent data sources that can be used as context, such as files, API responses, or system information.",
    standardDescription:
        "Request to access a resource provided by a connected MCP server. Resources represent data sources that can be used as context, such as files, API responses, or system information. You must only use this tool if you have been informed of the MCP server and the resource you are trying to access.",
    serverNameInstruction: "The name of the MCP server providing the resource",
    serverNameUsage: "server name here",
    uriInstruction: "The URI identifying the specific resource to access",
    uriUsage: "resource URI here",
}
export default prompts
