import type { McpServer, McpServerSource } from "@shared/mcp"
import { describe, expect, it } from "vitest"
import { projectMcpServersWithToggleOverrides } from "../mcp-server-toggle-projection"

function createServer(name: string, source: McpServerSource, disabled = false): McpServer {
	return {
		name,
		source,
		config: "{}",
		status: "connected",
		disabled,
	}
}

describe("projectMcpServersWithToggleOverrides", () => {
	it("applies explicit overrides to settings and workspace servers", () => {
		const settingsServer = createServer("catalog-server", "settings")
		const workspaceServer = createServer("workspace-server", "workspace", true)
		const untouchedServer = createServer("untouched-server", "settings")

		const projected = projectMcpServersWithToggleOverrides([settingsServer, workspaceServer, untouchedServer], {
			"catalog-server": false,
			"workspace-server": true,
		})

		expect(projected.map(({ name, disabled }) => ({ name, disabled }))).toEqual([
			{ name: "catalog-server", disabled: true },
			{ name: "workspace-server", disabled: false },
			{ name: "untouched-server", disabled: false },
		])
		expect(projected[2]).toBe(untouchedServer)
	})

	it("allows a later task override to win over a workspace override", () => {
		const workspaceProjection = projectMcpServersWithToggleOverrides([createServer("shared-server", "settings")], {
			"shared-server": false,
		})
		const taskProjection = projectMcpServersWithToggleOverrides(workspaceProjection, { "shared-server": true })

		expect(workspaceProjection[0]?.disabled).toBe(true)
		expect(taskProjection[0]?.disabled).toBe(false)
	})
})
