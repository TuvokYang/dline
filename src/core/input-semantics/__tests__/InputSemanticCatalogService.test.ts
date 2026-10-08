import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { type CapabilityInventory, InputSemanticCatalogService } from "../InputSemanticCatalogService"

function port(inventory: CapabilityInventory) {
	const state = { inventory, reads: 0 }
	return {
		port: {
			readInventory: async () => {
				state.reads += 1
				return state.inventory
			},
		},
		set(next: CapabilityInventory) {
			state.inventory = next
		},
		get reads() {
			return state.reads
		},
	}
}

const empty: CapabilityInventory = { skills: [], workflows: [], mcpPrompts: [] }

describe("InputSemanticCatalogService", () => {
	it("exposes the built-ins at revision 0 before discovery has run", () => {
		const service = new InputSemanticCatalogService(port(empty).port)

		const catalog = service.current()

		expect(catalog.revision).toBe(0)
		expect(catalog.descriptors).toEqual(BUILTIN_INPUT_SEMANTICS)
	})

	it("runs discovery once when a submission needs a catalog that was never discovered", async () => {
		const source = port({ skills: ["work-smoke-health"], workflows: [], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		const [first, second] = await Promise.all([service.discovered(), service.discovered()])

		expect(source.reads).toBe(1)
		expect(first.revision).toBe(1)
		expect(second).toBe(first)
		expect(first.descriptors.some((descriptor) => descriptor.id === "command.skill.work-smoke-health")).toBe(true)
	})

	it("reuses the published catalog instead of rediscovering on every submission", async () => {
		const source = port({ skills: ["a"], workflows: [], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		await service.discovered()
		await service.discovered()

		expect(source.reads).toBe(1)
	})

	it("publishes the built-in descriptors and the discovered capabilities under one revision", async () => {
		const source = port({ skills: ["work-smoke-health"], workflows: ["release"], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		const catalog = await service.refresh()

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

	it("keeps the revision stable when discovery reports the same capabilities", async () => {
		const source = port({ skills: ["a"], workflows: [], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		await service.refresh()
		const refreshed = await service.refresh()

		expect(refreshed.revision).toBe(1)
		expect(refreshed).toBe(service.current())
	})

	it("advances the revision when a capability is withdrawn so a cached consumer refreshes", async () => {
		const source = port({ skills: ["a"], workflows: [], mcpPrompts: [] })
		const service = new InputSemanticCatalogService(source.port)

		await service.refresh()
		source.set(empty)
		const refreshed = await service.refresh()

		expect(refreshed.revision).toBe(2)
		expect(refreshed.descriptors.some((descriptor) => descriptor.id === "command.skill.a")).toBe(false)
	})

	it("addresses an MCP prompt by server and prompt identity", async () => {
		const source = port({ skills: [], workflows: [], mcpPrompts: [{ server: "work-smoke-mcp", prompt: "echo" }] })

		const catalog = await new InputSemanticCatalogService(source.port).refresh()

		expect(catalog.descriptors).toContainEqual(
			expect.objectContaining({
				id: "command.mcp.work-smoke-mcp.echo",
				trigger: "/mcp:work-smoke-mcp:echo",
			}),
		)
	})
})
