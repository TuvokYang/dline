import { EmptyRequest } from "@shared/proto/dline/common"
import {
    VSCodeButton,
    VSCodeOption,
    VSCodeProgressRing,
    VSCodeRadio,
    VSCodeRadioGroup,
    VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { McpServiceClient } from "@/services/grpc-client"
import McpMarketplaceCard from "./McpMarketplaceCard"
import McpSubmitCard from "./McpSubmitCard"
import type { McpMarketplaceError } from "./marketplace-errors"

const McpMarketplaceView = () => {
    const { t } = useUiTranslation()
    const { mcpServers, mcpMarketplaceCatalog, setMcpMarketplaceCatalog, remoteConfigSettings } = useExtensionState()

    const showMarketplace = remoteConfigSettings?.mcpMarketplaceEnabled !== false
    const [isLoading, setIsLoading] = useState(showMarketplace)
    const [error, setError] = useState<McpMarketplaceError | null>(null)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
    const [sortBy, setSortBy] = useState<"newest" | "stars" | "name" | "downloadCount">("newest")

    const items = mcpMarketplaceCatalog?.items || []

    const categories = useMemo(() => {
        const uniqueCategories = new Set(items.map((item) => item.category))
        return Array.from(uniqueCategories).sort()
    }, [items])

    const filteredItems = useMemo(() => {
        return items
            .filter((item) => {
                const matchesSearch =
                    searchQuery === "" ||
                    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    item.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()))
                const matchesCategory = !selectedCategory || item.category === selectedCategory
                return matchesSearch && matchesCategory
            })
            .sort((a, b) => {
                switch (sortBy) {
                    case "downloadCount":
                        return b.downloadCount - a.downloadCount
                    case "stars":
                        return b.githubStars - a.githubStars
                    case "name":
                        return a.name.localeCompare(b.name)
                    case "newest":
                        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                    default:
                        return 0
                }
            })
    }, [items, searchQuery, selectedCategory, sortBy])

    // Keeping this callback referentially stable is required: it is an effect dependency,
    // and an unstable identity would re-trigger the fetch on every render.
    const fetchMarketplace = useCallback(
        (forceRefresh = false) => {
            if (!showMarketplace) {
                setIsLoading(false)
                setIsRefreshing(false)
                return
            }

            if (forceRefresh) {
                setIsRefreshing(true)
            } else {
                setIsLoading(true)
            }
            setError(null)

            McpServiceClient.refreshMcpMarketplace(EmptyRequest.create({}))
                .then((response) => {
                    setMcpMarketplaceCatalog(response)
                })
                .catch((requestError) => {
                    console.error("Error refreshing MCP marketplace:", requestError)
                    setError({
                        kind: "load",
                        diagnostics: requestError instanceof Error ? requestError.message : String(requestError),
                    })
                })
                .finally(() => {
                    setIsLoading(false)
                    setIsRefreshing(false)
                })
        },
        [showMarketplace, setMcpMarketplaceCatalog],
    )

    const hasRequestedCatalogRef = useRef(false)

    useEffect(() => {
        // Fetch the catalog once per mount. Later updates arrive through the catalog
        // subscription in ExtensionStateContext or through an explicit retry.
        if (hasRequestedCatalogRef.current) {
            return
        }
        hasRequestedCatalogRef.current = true
        fetchMarketplace()
    }, [fetchMarketplace])

    const isBusy = isLoading || isRefreshing

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                width: "100%",
            }}>
            <div style={{ padding: "20px 20px 5px", display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* Search row */}
                <VSCodeTextField
                    aria-label={t("capabilities.mcp.marketplace.search")}
                    onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                    placeholder={t("capabilities.mcp.marketplace.search")}
                    style={{ width: "100%" }}
                    value={searchQuery}>
                    <div
                        className="codicon codicon-search"
                        slot="start"
                        style={{
                            fontSize: 13,
                            opacity: 0.8,
                        }}
                    />
                    {searchQuery && (
                        <div
                            aria-label={t("capabilities.mcp.marketplace.clearSearch")}
                            className="codicon codicon-close"
                            onClick={() => setSearchQuery("")}
                            slot="end"
                            style={{
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                height: "100%",
                                cursor: "pointer",
                            }}
                        />
                    )}
                </VSCodeTextField>

                {/* Filter row */}
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                    }}>
                    <span
                        style={{
                            fontSize: "11px",
                            color: "var(--vscode-descriptionForeground)",
                            textTransform: "uppercase",
                            fontWeight: 500,
                            flexShrink: 0,
                        }}>
                        {t("capabilities.mcp.marketplace.filter")}
                    </span>
                    <div
                        style={{
                            position: "relative",
                            zIndex: 2,
                            flex: 1,
                        }}>
                        <LocalizedDropdown
                            aria-label={t("capabilities.mcp.marketplace.filter")}
                            onChange={(e: Event | FormEvent<HTMLElement>) =>
                                setSelectedCategory((e.target as HTMLSelectElement).value || null)
                            }
                            selectedLabel={
                                (selectedCategory || "") === ""
                                    ? t("capabilities.mcp.marketplace.allCategories")
                                    : categories.find((category) => category === selectedCategory)
                            }
                            style={{
                                width: "100%",
                            }}
                            value={selectedCategory || ""}>
                            <LocalizedOption label={t("capabilities.mcp.marketplace.allCategories")} value="" />
                            {categories.map((category) => (
                                <VSCodeOption key={category} value={category}>
                                    {category}
                                </VSCodeOption>
                            ))}
                        </LocalizedDropdown>
                    </div>
                </div>

                {/* Sort row */}
                <div
                    style={{
                        display: "flex",
                        gap: "8px",
                    }}>
                    <span
                        style={{
                            fontSize: "11px",
                            color: "var(--vscode-descriptionForeground)",
                            textTransform: "uppercase",
                            fontWeight: 500,
                            marginTop: "3px",
                        }}>
                        {t("capabilities.mcp.marketplace.sort")}
                    </span>
                    <VSCodeRadioGroup
                        aria-label={t("capabilities.mcp.marketplace.sort")}
                        onChange={(e) => setSortBy((e.target as HTMLInputElement).value as typeof sortBy)}
                        style={{
                            display: "flex",
                            flexWrap: "wrap",
                            marginTop: "-2.5px",
                        }}
                        value={sortBy}>
                        <VSCodeRadio value="downloadCount">{t("capabilities.mcp.marketplace.installs")}</VSCodeRadio>
                        <VSCodeRadio value="newest">{t("capabilities.mcp.marketplace.newest")}</VSCodeRadio>
                        <VSCodeRadio value="stars">{t("capabilities.mcp.marketplace.stars")}</VSCodeRadio>
                        <VSCodeRadio value="name">{t("capabilities.mcp.marketplace.name")}</VSCodeRadio>
                    </VSCodeRadioGroup>
                </div>
            </div>

            <style>
                {`
				.mcp-search-input,
				.mcp-select {
				box-sizing: border-box;
				}
				.mcp-search-input {
				min-width: 140px;
				}
				.mcp-search-input:focus,
				.mcp-select:focus {
				border-color: var(--vscode-focusBorder) !important;
				}
				.mcp-search-input:hover,
				.mcp-select:hover {
				opacity: 0.9;
				}
			`}
            </style>

            {/* Remote config banner */}
            {remoteConfigSettings?.allowedMCPServers && (
                <div className="flex items-center gap-2 px-5 py-3 mx-5 mb-4 bg-vscode-textBlockQuote-background border-l-[3px] border-vscode-textLink-foreground">
                    <i className="codicon codicon-lock text-sm" />
                    <span className="text-[13px]">{t("capabilities.mcp.marketplace.preconfigured")}</span>
                </div>
            )}

            {/* Only the result area swaps between states so the search field keeps focus while loading. */}
            {isBusy ? (
                <div
                    style={{
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        padding: "40px 20px",
                    }}>
                    <VSCodeProgressRing aria-label={t("capabilities.mcp.marketplace.loading")} />
                </div>
            ) : error ? (
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems: "center",
                        padding: "40px 20px",
                        gap: "12px",
                    }}>
                    <div role="alert" style={{ color: "var(--vscode-errorForeground)" }}>
                        {t(
                            error.kind === "load"
                                ? "capabilities.mcp.marketplace.loadError"
                                : "capabilities.mcp.marketplace.installError",
                        )}
                        {error.diagnostics && (
                            <details>
                                <summary>{t("capabilities.diagnostics")}</summary>
                                {error.diagnostics}
                            </details>
                        )}
                    </div>
                    <VSCodeButton appearance="secondary" onClick={() => fetchMarketplace(true)}>
                        <span className="codicon codicon-refresh" style={{ marginRight: "6px" }} />
                        {t("capabilities.mcp.marketplace.retry")}
                    </VSCodeButton>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {filteredItems.length === 0 ? (
                        <div
                            style={{
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                padding: "40px 20px",
                                color: "var(--vscode-descriptionForeground)",
                            }}>
                            {searchQuery || selectedCategory
                                ? t("capabilities.mcp.marketplace.noMatching")
                                : t("capabilities.mcp.marketplace.empty")}
                        </div>
                    ) : (
                        filteredItems.map((item) => (
                            <McpMarketplaceCard installedServers={mcpServers} item={item} key={item.mcpId} setError={setError} />
                        ))
                    )}
                    <McpSubmitCard />
                </div>
            )}
        </div>
    )
}

export default McpMarketplaceView
