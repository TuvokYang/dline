// English MCP prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	standardCatalogGuidance:
		"MCP tools connect Dline to external services, data sources, and specialized operations that are not provided by built-in tools. Use `load_mcp` to inspect one advertised MCP tool's detailed metadata and input schema before calling it. Loading does not execute the tool; use `use_mcp_tool` with the matching server and tool names when execution is required.",
	liteCatalogGuidance:
		"MCP tools connect Dline to external services, data sources, and specialized operations that are not provided by built-in tools. This Lite profile lists connected MCP tools for awareness but does not expose MCP metadata-loading or execution tools; switch to a profile that exposes them when an MCP operation is required.",
	standardCatalogListIntroduction: "The MCP tools available to the current task are listed below:",
	liteCatalogListIntroduction: "The connected MCP tools known to the current task are listed below:",
}

export default prompts
