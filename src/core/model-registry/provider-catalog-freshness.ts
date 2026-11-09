/**
 * Freshness of a remotely derived provider catalog.
 *
 * Vendor listings are pulled on demand, not on a schedule, so the only useful
 * question a caller can ask is whether the catalog it already has is recent
 * enough to serve. `persistProviderCatalog` writes these files, which makes the
 * stored file's modification time the record of the last successful pull.
 */
import fs from "fs/promises"
import * as path from "path"
import { ModelRegistry } from "./ModelRegistry"
import { getProviderConfigFileName } from "./provider-config-file"

/**
 * Catalogues this old are refreshed on the next opportunity. A day keeps a
 * long-lived window from serving a listing that has drifted for weeks without
 * turning every Webview remount into a network request.
 */
export const PROVIDER_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1_000

/** Whether the stored catalog is missing or older than `maxAgeMs`. */
export async function isProviderCatalogStale(providerId: string, maxAgeMs = PROVIDER_CATALOG_MAX_AGE_MS): Promise<boolean> {
    const registry = ModelRegistry.getInstance()
    const filePath = path.join(registry.providersDir, getProviderConfigFileName(providerId))
    try {
        const stats = await fs.stat(filePath)
        return Date.now() - stats.mtimeMs > maxAgeMs
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
        // An unreadable timestamp cannot prove the catalog is current, but it also
        // must not turn every caller into an unbounded retry loop.
        return false
    }
}
