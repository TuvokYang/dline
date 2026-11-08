import {
    DEFAULT_LOCAL_SEARCH_ENGINE,
    isLocalSearchEngineId,
    LOCAL_SEARCH_ENGINE_IDS,
    type LocalSearchEngineId,
} from "@shared/web-search"
import { type ChangeEvent, type FocusEvent, useEffect, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { updateSetting } from "../utils/settingsHandlers"

interface WebToolsSettingsProps {
    localWebSearchEngine?: LocalSearchEngineId
    searxngSearchUrl?: string
}

const engineLabelKeys = {
    duckduckgo: "settings.ui.web.duckDuckGo",
    bing: "settings.ui.web.bing",
    searxng: "settings.ui.web.searXng",
} as const satisfies Record<LocalSearchEngineId, string>

const fieldClassName =
    "w-full rounded border border-input-border bg-input-background px-2 py-1 text-sm text-input-foreground outline-none focus:border-focus-border"

const WebToolsSettings = ({ localWebSearchEngine, searxngSearchUrl }: WebToolsSettingsProps) => {
    const { t } = useUiTranslation()
    const [engine, setEngine] = useState(localWebSearchEngine ?? DEFAULT_LOCAL_SEARCH_ENGINE)
    const [localUrl, setLocalUrl] = useState(searxngSearchUrl ?? "")
    const [token, setToken] = useState("")

    useEffect(() => {
        setEngine(localWebSearchEngine ?? DEFAULT_LOCAL_SEARCH_ENGINE)
    }, [localWebSearchEngine])

    useEffect(() => {
        setLocalUrl(searxngSearchUrl ?? "")
    }, [searxngSearchUrl])

    const handleEngineChange = (event: ChangeEvent<HTMLSelectElement>) => {
        if (!isLocalSearchEngineId(event.target.value)) return
        setEngine(event.target.value)
        updateSetting("localWebSearchEngine", event.target.value)
    }

    const handleUrlBlur = (event: FocusEvent<HTMLInputElement>) => {
        updateSetting("searxngSearchUrl", event.target.value)
    }

    const handleTokenBlur = (event: FocusEvent<HTMLInputElement>) => {
        if (!event.target.value) return
        updateSetting("searxngSearchToken", event.target.value)
        setToken("")
    }

    return (
        <div className="space-y-3 border-t border-editor-widget-border/50 pb-3 pt-3" data-testid="web-tools-settings">
            <div className="space-y-1">
                <label className="block text-xs font-medium text-foreground" htmlFor="local-web-search-engine">
                    {t("settings.ui.web.engine")}
                </label>
                <select
                    aria-label={t("settings.ui.web.engine")}
                    className={fieldClassName}
                    id="local-web-search-engine"
                    onChange={handleEngineChange}
                    value={engine}>
                    {LOCAL_SEARCH_ENGINE_IDS.map((value) => (
                        <option key={value} value={value}>
                            {t(engineLabelKeys[value])}
                        </option>
                    ))}
                </select>
                <p className="text-xs text-description">{t("settings.ui.web.engineHelp")}</p>
            </div>

            {engine === "searxng" && (
                <div className="space-y-3">
                    <div className="space-y-1">
                        <label className="block text-xs font-medium text-foreground" htmlFor="searxng-search-url">
                            SearXNG URL
                        </label>
                        <input
                            aria-label="SearXNG URL"
                            className={fieldClassName}
                            id="searxng-search-url"
                            onBlur={handleUrlBlur}
                            onChange={(event) => setLocalUrl(event.target.value)}
                            placeholder="https://search.example.com"
                            type="url"
                            value={localUrl}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="block text-xs font-medium text-foreground" htmlFor="searxng-search-token">
                            {t("settings.ui.web.token")}
                        </label>
                        <input
                            aria-label={t("settings.ui.web.token")}
                            autoComplete="new-password"
                            className={fieldClassName}
                            id="searxng-search-token"
                            onBlur={handleTokenBlur}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={t("settings.ui.web.keepToken")}
                            type="password"
                            value={token}
                        />
                        <p className="text-xs text-description">{t("settings.ui.web.tokenHelp")}</p>
                    </div>
                </div>
            )}
        </div>
    )
}

export default WebToolsSettings
