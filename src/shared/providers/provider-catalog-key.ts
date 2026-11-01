/**
 * Resolves which model catalog a Profile reads.
 *
 * A provider exposes one selectable identity, but a Profile may choose an option
 * that changes its catalog: a region endpoint, or a billing mode whose plan
 * covers a different model set. A catalog is therefore keyed by the provider
 * plus the option that selects it, and every consumer turns that choice into
 * the key.
 *
 * This module is the only place that does so. A handler, a settings card and a
 * usage adapter that each derived the key themselves would disagree as soon as
 * one of them changed, and the disagreement would surface as a missing model or
 * a wrongly priced one rather than as an error.
 */

/** Catalog key of the user-visible OpenCode provider. */
export const OPENCODE_CONSOLE_CATALOG = "opencode"

/** Catalog key of the OpenCode Go plan catalog. */
export const OPENCODE_GO_CATALOG = "opencode-go"

/** Catalog key of the mainland-China Qwen endpoint. */
export const QWEN_MAINLAND_CATALOG = "qwen-cn"

/** Catalog key of the mainland-China Z AI endpoint. */
export const ZAI_MAINLAND_CATALOG = "zai-cn"

/** Region a Profile talks to, for a provider that serves more than one. */
export type ProviderRegion = "mainland" | "international"

/**
 * The OpenCode plan a Profile is billed against.
 *
 * The gateway sells four plans but only two model catalogs: Go, Go Plus and Go
 * Teams serve the same catalog and differ only in a model's monthly included
 * usage. Catalog resolution therefore treats the three subscription plans alike,
 * while the usage surface still needs to know which plan a Profile declared.
 */
export type OpenCodeMode = "console" | "go" | "go-plus" | "go-teams"

/**
 * The subset of a provider configuration this resolver reads.
 *
 * Only the fact that selects a catalog is modelled; everything else about the
 * configuration stays with the provider that owns it.
 */
export interface CatalogSelection {
    readonly provider: string
    /**
     * OpenCode billing mode. Absent means the stored mode was unspecified, which
     * resolves to the Console catalog that every OpenCode Profile started with.
     */
    readonly opencodeMode?: OpenCodeMode
    /**
     * Endpoint region for a provider that serves separate mainland and
     * international catalogs. Absent means the international catalog, which is
     * the endpoint every such Profile started with.
     */
    readonly region?: ProviderRegion
}

/**
 * Resolve the catalog key for a Profile's provider choice.
 *
 * @param selection Provider identity and the catalog-selecting option, if any.
 * @returns The registry key whose catalog this Profile reads.
 */
export function resolveCatalogProviderKey(selection: Readonly<CatalogSelection>): string {
    // A provider without a catalog-selecting option reads its own catalog. This
    // keeps every existing provider byte-for-byte equivalent.
    if (selection.provider === OPENCODE_CONSOLE_CATALOG) {
        // Every subscription tier reads the Go catalog; only the included monthly
        // allowance differs, which is a usage question rather than a catalog one.
        // An unknown mode name answers with the Console catalog: a value this build
        // does not understand must not silently unlock a different model set.
        return selection.opencodeMode === "go" || selection.opencodeMode === "go-plus" || selection.opencodeMode === "go-teams"
            ? OPENCODE_GO_CATALOG
            : OPENCODE_CONSOLE_CATALOG
    }
    // A regional provider keeps one catalog per endpoint. An unknown or absent
    // region keeps the international catalog rather than guessing.
    if (selection.region !== "mainland") return selection.provider
    switch (selection.provider) {
        case "qwen":
            return QWEN_MAINLAND_CATALOG
        case "zai":
            return ZAI_MAINLAND_CATALOG
        default:
            return selection.provider
    }
}
