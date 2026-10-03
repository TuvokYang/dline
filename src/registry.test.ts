import { describe, expect, it, vi } from "vitest"
import { name, publisher, version } from "../package.json"

vi.unmock("./registry")

describe("ExtensionRegistryInfo", () => {
	it("uses the current distribution package identity", async () => {
		const { ExtensionRegistryInfo } = await import("./registry")

		expect(ExtensionRegistryInfo.id).toBe(`${publisher}.${name}`)
		expect(ExtensionRegistryInfo.name).toBe(name)
		expect(ExtensionRegistryInfo.version).toBe(version)
	})

	it("keeps contribution IDs stable for production and Insiders packages", async () => {
		const { createExtensionRegistryInfo, ExtensionRegistryInfo } = await import("./registry")
		const insiders = createExtensionRegistryInfo({ name: "dline-insiders", publisher, version: "0.9.1234567890" })

		expect(insiders.id).toBe(`${publisher}.dline-insiders`)
		expect(insiders.contributionNamespace).toBe("dline")
		expect(insiders.commands).toEqual(ExtensionRegistryInfo.commands)
		expect(insiders.viewContainers).toEqual({ ActivityBar: "dline-ActivityBar" })
		expect(insiders.views).toEqual({ Sidebar: "dline.SidebarProvider" })
		for (const command of Object.values(insiders.commands)) {
			expect(command.startsWith("dline.")).toBe(true)
		}
	})
})
