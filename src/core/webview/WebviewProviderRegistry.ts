import { WebviewProvider } from "./WebviewProvider"

/**
 * Registry of all active WebviewProvider instances.
 * Supports lookup by provider ID, task ID, and the sidebar singleton.
 *
 * Each WebviewProvider maps to one Controller and one Task.
 */
export class WebviewProviderRegistry {
    private static providers = new Map<string, WebviewProvider>()
    private static sidebarInstance: WebviewProvider | null = null
    private static nextId = 0

    /**
     * Registers a provider and returns its generated ID.
     * The first registered provider is automatically tracked as the sidebar instance.
     */
    static register(provider: WebviewProvider, isSidebar = false): string {
        const id = `provider_${++WebviewProviderRegistry.nextId}`
        WebviewProviderRegistry.providers.set(id, provider)
        if (isSidebar) {
            WebviewProviderRegistry.sidebarInstance = provider
        }
        return id
    }

    /** Unregisters a provider by ID. */
    static unregister(id: string): boolean {
        const provider = WebviewProviderRegistry.providers.get(id)
        if (provider && WebviewProviderRegistry.sidebarInstance === provider) {
            WebviewProviderRegistry.sidebarInstance = null
        }
        return WebviewProviderRegistry.providers.delete(id)
    }

    /** Returns all active provider instances. */
    static getAll(): WebviewProvider[] {
        return Array.from(WebviewProviderRegistry.providers.values())
    }

    /** Returns the current sidebar provider instance, if any. */
    static getSidebar(): WebviewProvider | null {
        // Try visible sidebar first
        if (WebviewProviderRegistry.sidebarInstance?.isVisible()) {
            return WebviewProviderRegistry.sidebarInstance
        }
        return WebviewProviderRegistry.sidebarInstance
    }

    /** Returns all active panel (non-sidebar) providers. */
    static getPanels(): WebviewProvider[] {
        const panels: WebviewProvider[] = []
        for (const provider of WebviewProviderRegistry.providers.values()) {
            if (provider !== WebviewProviderRegistry.sidebarInstance) {
                panels.push(provider)
            }
        }
        return panels
    }

    /** Returns the total number of active providers. */
    static get count(): number {
        return WebviewProviderRegistry.providers.size
    }

    /** Disposes all providers and clears the registry. */
    static async disposeAll(): Promise<void> {
        const providers = Array.from(WebviewProviderRegistry.providers.values())
        for (const provider of providers) {
            await provider.dispose()
        }
        WebviewProviderRegistry.providers.clear()
        WebviewProviderRegistry.sidebarInstance = null
    }
}
