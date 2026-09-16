import type { McpServer } from "@shared/mcp"

/**
 * Apply one sparse capability scope without mutating the shared MCP server state.
 *
 * Later scopes can project over this result, so task preferences remain able to
 * override workspace preferences while the shared McpHub connection stays live.
 */
export function projectMcpServersWithToggleOverrides(
	servers: readonly McpServer[],
	overrides: Readonly<Record<string, boolean>>,
): McpServer[] {
	return servers.map((server) => {
		if (!Object.hasOwn(overrides, server.name)) return server
		return { ...server, disabled: overrides[server.name] !== true }
	})
}
