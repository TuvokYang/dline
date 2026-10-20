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

    it("preserves the stable distribution contribution contract", async () => {
        const { createExtensionRegistryInfo } = await import("./registry")
        const stable = createExtensionRegistryInfo({ name: "dline", publisher, version: "0.12.0" })

        expect(stable.contributionNamespace).toBe("dline")
        expect(stable.viewContainers).toEqual({ ActivityBar: "dline-ActivityBar" })
        expect(stable.views).toEqual({ Sidebar: "dline.SidebarProvider" })
        expect(stable.panelViewType).toBe("dlineTask")
        expect(stable.diffUriScheme).toBe("cline-diff")
        expect(stable.commentControllerId).toBe("dline-ai-review")
        expect(stable.productIconId).toBe("dline-icon")
        expect(stable.contextKeys).toEqual({
            accountEnabled: "dline.accountEnabled",
            isGeneratingCommit: "dline.isGeneratingCommit",
            isDevMode: "dline.isDevMode",
            isTestMode: "dline.isTestMode",
        })
    })

    it("gives Insiders an independent VS Code-global identity", async () => {
        const { createExtensionRegistryInfo } = await import("./registry")
        const stable = createExtensionRegistryInfo({ name: "dline", publisher, version: "0.12.0" })
        const insiders = createExtensionRegistryInfo({ name: "dline-insiders", publisher, version: "0.13.1234567890" })

        expect(insiders.id).toBe(`${publisher}.dline-insiders`)
        expect(insiders.displayName).toBe("Dline (Insiders)")
        expect(insiders.isInsiders).toBe(true)
        expect(insiders.contributionNamespace).toBe("dline-insiders")
        expect(insiders.walkthrough.id).toBe(stable.walkthrough.id)
        expect(insiders.walkthrough.qualifiedId).not.toBe(stable.walkthrough.qualifiedId)

        const stableGlobalIds = new Set([
            ...Object.values(stable.commands),
            ...Object.values(stable.viewContainers),
            ...Object.values(stable.views),
            ...Object.values(stable.contextKeys),
            stable.panelViewType,
            stable.diffUriScheme,
            stable.commentControllerId,
            stable.productIconId,
        ])
        const insidersGlobalIds = [
            ...Object.values(insiders.commands),
            ...Object.values(insiders.viewContainers),
            ...Object.values(insiders.views),
            ...Object.values(insiders.contextKeys),
            insiders.panelViewType,
            insiders.diffUriScheme,
            insiders.commentControllerId,
            insiders.productIconId,
        ]

        for (const id of insidersGlobalIds) {
            expect(stableGlobalIds.has(id), `Insiders global ID '${id}' must not collide with Stable`).toBe(false)
        }
    })

    it("rejects a package that has no registered contribution identity", async () => {
        const { createExtensionRegistryInfo } = await import("./registry")

        expect(() => createExtensionRegistryInfo({ name: "unknown", publisher, version: "1.0.0" })).toThrow(
            "No VS Code contribution identity",
        )
    })
})
