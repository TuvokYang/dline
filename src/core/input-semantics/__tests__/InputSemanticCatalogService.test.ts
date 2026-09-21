import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { type CapabilityInventory, InputSemanticCatalogService } from "../InputSemanticCatalogService"

function port(inventory: CapabilityInventory) {
	const state = { inventory }
	return {
		port: { readInventory: () => state.inventory },
		set(next: CapabilityInventory) {
			state.inventory = next
		},
	}
}

const empty: CapabilityInventory = { skills: [], workflows: [], mcpPrompts: [] }

describe("InputSemanticCatalogService", () => {
	it("publishes the built-in descriptors and the discovered capabilities under one revision", () => {
		const source = port({ skills: ["work-smoke-health"], workflows: ["release"], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		const catalog = service.current()

		expect(catalog.revision).toBe(1)
		expect(catalog.descriptors).toHaveLength(BUILTIN_INPUT_SEMANTICS.length + 2)
		expect(catalog.descriptors).toContainEqual(
			expect.objectContaining({
				id: "command.skill.work-smoke-health",
				trigger: "/skills:work-smoke-health",
				dynamic: true,
				composition: "combinable",
			}),
		)
	})

	it("keeps the revision stable when discovery reports the same capabilities", () => {
		const source = port({ skills: ["a"], workflows: [], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		const refreshed = service.refresh()

		expect(refreshed.revision).toBe(1)
		expect(refreshed).toBe(service.current())
	})

	it("advances the revision when a capability is withdrawn so a cached consumer refreshes", () => {
		const source = port({ skills: ["a"], workflows: [], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		source.set(empty)
		const refreshed = service.refresh()

		expect(refreshed.revision).toBe(2)
		expect(refreshed.descriptors.some((descriptor) => descriptor.id === "command.skill.a")).toBe(false)
	})

	it("addresses an MCP prompt by server and prompt identity", () => {
		const source = port({ skills: [], workflows: [], mcpPrompts: [{ server: "work-smoke-mcp", prompt: "echo" }] })

		const catalog = new InputSemanticCatalogService(source.port).current()

		expect(catalog.descriptors).toContainEqual(
			expect.objectContaining({
				id: "command.mcp.work-smoke-mcp.echo",
				trigger: "/mcp:work-smoke-mcp:echo",
			}),
		)
	})
})
