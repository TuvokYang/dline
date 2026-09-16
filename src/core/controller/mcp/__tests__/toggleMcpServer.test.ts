import type { McpServer } from "@shared/mcp"
import { ToggleMcpServerRequest } from "@shared/proto/dline/mcp"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../../index"
import { toggleMcpServer } from "../toggleMcpServer"

const mocks = vi.hoisted(() => ({
	sendMcpServersUpdate: vi.fn(),
}))

vi.mock("../subscribeToMcpServers", () => ({
	sendMcpServersUpdate: mocks.sendMcpServersUpdate,
}))

function createServer(disabled: boolean): McpServer {
	return {
		name: "catalog-server",
		source: "settings",
		config: "{}",
		status: "connected",
		disabled,
	}
}

function createController(hasWorkspaceScope: boolean) {
	const setWorkspaceMcpServerEnabled = vi.fn()
	const toggleServerDisabledRPC = vi.fn().mockResolvedValue(undefined)
	const getLatestMcpServersForOwner = vi.fn().mockResolvedValue([createServer(true)])
	const controller = {
		stateManager: { hasWorkspaceScope },
		setWorkspaceMcpServerEnabled,
		getLatestMcpServersForOwner,
		mcpHub: { toggleServerDisabledRPC },
	} as unknown as Controller

	return {
		controller,
		setWorkspaceMcpServerEnabled,
		toggleServerDisabledRPC,
		getLatestMcpServersForOwner,
	}
}

describe("toggleMcpServer", () => {
	beforeEach(() => {
		mocks.sendMcpServersUpdate.mockReset().mockResolvedValue(undefined)
	})

	it("stores a settings-source server toggle in workspace scope without disabling the shared connection", async () => {
		const fixture = createController(true)

		const response = await toggleMcpServer(
			fixture.controller,
			ToggleMcpServerRequest.create({ serverName: "catalog-server", disabled: true }),
		)

		expect(fixture.setWorkspaceMcpServerEnabled).toHaveBeenCalledWith("catalog-server", false)
		expect(fixture.toggleServerDisabledRPC).not.toHaveBeenCalled()
		expect(mocks.sendMcpServersUpdate).toHaveBeenCalledOnce()
		expect(fixture.getLatestMcpServersForOwner).toHaveBeenCalledOnce()
		expect(response.mcpServers[0]?.disabled).toBe(true)
	})

	it("uses the shared physical toggle when no workspace scope exists", async () => {
		const fixture = createController(false)

		await toggleMcpServer(fixture.controller, ToggleMcpServerRequest.create({ serverName: "catalog-server", disabled: true }))

		expect(fixture.toggleServerDisabledRPC).toHaveBeenCalledWith("catalog-server", true)
		expect(fixture.setWorkspaceMcpServerEnabled).not.toHaveBeenCalled()
		expect(mocks.sendMcpServersUpdate).not.toHaveBeenCalled()
		expect(fixture.getLatestMcpServersForOwner).toHaveBeenCalledOnce()
	})
})
