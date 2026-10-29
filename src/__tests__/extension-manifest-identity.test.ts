import { describe, expect, it, vi } from "vitest"
import packageJson from "../../package.json"
import {
    createDistributionManifest,
    getDistributionIdentity,
    INSIDERS_PACKAGE_NAME,
    STABLE_PACKAGE_NAME,
} from "../../scripts/extension-manifest-identity.mjs"

vi.unmock("../registry")

interface ManifestCommand {
    command: string
    title: string
    category?: string
    icon?: string
    when?: string
    enablement?: string
}

interface ManifestMenuItem {
    command: string
    when?: string
    enablement?: string
}

interface ExtensionManifest {
    name: string
    displayName: string
    version: string
    publisher: string
    preview?: boolean
    icon: string
    repository: unknown
    activationEvents: string[]
    contributes: {
        icons: Record<string, unknown>
        viewsContainers: { activitybar: Array<{ id: string; title: string }> }
        views: Record<string, Array<{ id: string }>>
        commands: ManifestCommand[]
        keybindings?: Array<{ command: string; when?: string }>
        menus: Record<string, ManifestMenuItem[]>
        configuration: { title: string }
    }
}

const sourceManifest = packageJson as unknown as ExtensionManifest

function project(packageName: string, version: string): ExtensionManifest {
    return createDistributionManifest(sourceManifest, packageName, version) as unknown as ExtensionManifest
}

function extensionOwnedCommandIds(manifest: ExtensionManifest): string[] {
    return manifest.contributes.commands.map(({ command }) => command)
}

describe("extension distribution manifest identity", () => {
    it("leaves the stable VS Code identity unchanged", () => {
        const stable = project(STABLE_PACKAGE_NAME, sourceManifest.version)

        expect(stable.name).toBe("dline")
        expect(stable.displayName).toBe("Dline")
        expect(stable.preview).toBeUndefined()
        expect(stable.contributes.viewsContainers.activitybar).toEqual([
            expect.objectContaining({ id: "dline-ActivityBar", title: "Dline" }),
        ])
        expect(stable.contributes.views["dline-ActivityBar"]).toEqual([expect.objectContaining({ id: "dline.SidebarProvider" })])
        expect(stable.contributes.keybindings).toEqual(sourceManifest.contributes.keybindings)
    })

    it("projects an independent and internally consistent Insiders identity", () => {
        const insiders = project(INSIDERS_PACKAGE_NAME, "0.13.1893456000")
        const identity = getDistributionIdentity(INSIDERS_PACKAGE_NAME)

        expect(insiders.name).toBe("dline-insiders")
        expect(insiders.displayName).toBe("Dline (Insiders)")
        expect(insiders.version).toBe("0.13.1893456000")
        expect(insiders.preview).toBe(true)
        expect(insiders.contributes.viewsContainers.activitybar).toEqual([
            expect.objectContaining({ id: identity.activityBarId, title: identity.displayName }),
        ])
        expect(insiders.contributes.views[identity.activityBarId]).toEqual([
            expect.objectContaining({ id: identity.sidebarViewId }),
        ])
        expect(insiders.contributes.views["dline-ActivityBar"]).toBeUndefined()
        expect(insiders.contributes.icons[identity.productIconId]).toBeDefined()
        expect(insiders.contributes.icons["dline-icon"]).toBeUndefined()
        expect(insiders.contributes.configuration.title).toBe(identity.displayName)
        expect(insiders.contributes.keybindings).toEqual([
            expect.objectContaining({
                command: "editor.action.submitComment",
                when: `commentEditorFocused && commentController == ${identity.commentControllerId} && !commentIsEmpty`,
            }),
        ])

        const commandIds = extensionOwnedCommandIds(insiders)
        expect(commandIds.length).toBeGreaterThan(0)
        expect(commandIds.every((command) => command.startsWith(`${identity.contributionNamespace}.`))).toBe(true)
        expect(insiders.contributes.commands.map(({ title }) => title)).toEqual(
            sourceManifest.contributes.commands.map(({ title }) => title),
        )
        expect(insiders.contributes.commands.find(({ icon }) => icon === `$(${identity.productIconId})`)).toBeDefined()

        const viewTitleItems = insiders.contributes.menus["view/title"]
        expect(viewTitleItems).toHaveLength(5)
        expect(viewTitleItems.every(({ command }) => command.startsWith(`${identity.contributionNamespace}.`))).toBe(true)
        expect(viewTitleItems.every(({ when }) => when?.includes(identity.sidebarViewId))).toBe(true)
        expect(viewTitleItems.filter(({ when }) => when?.includes(identity.contextKeys.accountEnabled))).toHaveLength(1)

        const commentItems = [
            ...insiders.contributes.menus["comments/commentThread/context"],
            ...insiders.contributes.menus["comments/commentThread/title"],
        ]
        expect(commentItems.every(({ when }) => when?.includes(identity.commentControllerId))).toBe(true)
        expect(insiders.contributes.commands.find(({ command }) => command.endsWith(".dev.createTestTasks"))?.when).toBe(
            identity.contextKeys.isDevMode,
        )
        expect(insiders.contributes.menus["scm/title"].map(({ when }) => when)).toEqual([
            `config.git.enabled && scmProvider == git && !${identity.contextKeys.isGeneratingCommit}`,
            `config.git.enabled && scmProvider == git && ${identity.contextKeys.isGeneratingCommit}`,
        ])
    })

    it("keeps the packaged manifest aligned with the runtime registry", async () => {
        const { createExtensionRegistryInfo } = await import("../registry")
        const insiders = project(INSIDERS_PACKAGE_NAME, "0.13.1893456000")
        const runtime = createExtensionRegistryInfo({
            name: INSIDERS_PACKAGE_NAME,
            publisher: sourceManifest.publisher,
            version: insiders.version,
        })
        const runtimeCommands = new Set(Object.values(runtime.commands))

        for (const command of extensionOwnedCommandIds(insiders)) {
            expect(runtimeCommands.has(command), `Packaged command '${command}' must have a runtime identity`).toBe(true)
        }
        expect(insiders.contributes.viewsContainers.activitybar[0]?.id).toBe(runtime.viewContainers.ActivityBar)
        expect(insiders.contributes.views[runtime.viewContainers.ActivityBar]?.[0]?.id).toBe(runtime.views.Sidebar)
        expect(insiders.contributes.icons[runtime.productIconId]).toBeDefined()
        expect(insiders.contributes.menus["view/title"].map(({ when }) => when)).toEqual([
            `view == ${runtime.views.Sidebar}`,
            `view == ${runtime.views.Sidebar}`,
            `view == ${runtime.views.Sidebar}`,
            `view == ${runtime.views.Sidebar} && ${runtime.contextKeys.accountEnabled}`,
            `view == ${runtime.views.Sidebar}`,
        ])
        expect(insiders.contributes.menus["comments/commentThread/context"][0]?.when).toBe(
            `commentController == ${runtime.commentControllerId}`,
        )
    })

    it("keeps Stable and Insiders manifest-owned commands disjoint", () => {
        const stable = project(STABLE_PACKAGE_NAME, sourceManifest.version)
        const insiders = project(INSIDERS_PACKAGE_NAME, "0.13.1893456000")
        const stableCommands = new Set(extensionOwnedCommandIds(stable))

        for (const command of extensionOwnedCommandIds(insiders)) {
            expect(stableCommands.has(command), `Insiders command '${command}' must not collide with Stable`).toBe(false)
        }
    })

    it("does not mutate the source manifest or unrelated package metadata", () => {
        const sourceKeybindings = structuredClone(sourceManifest.contributes.keybindings)
        const insiders = project(INSIDERS_PACKAGE_NAME, "0.13.1893456000")

        expect(sourceManifest.name).toBe("dline")
        expect(sourceManifest.contributes.keybindings).toEqual(sourceKeybindings)
        expect(insiders.icon).toBe(sourceManifest.icon)
        expect(insiders.repository).toEqual(sourceManifest.repository)
        expect(insiders.activationEvents).toEqual(sourceManifest.activationEvents)
    })
})
