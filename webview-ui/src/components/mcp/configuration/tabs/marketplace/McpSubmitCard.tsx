import { CapabilityRichText } from "@/components/agent-capabilities/CapabilityRichText"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

const McpSubmitCard = () => {
    const { t } = useUiTranslation()
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
                padding: "15px",
                margin: "20px",
                backgroundColor: "var(--vscode-textBlockQuote-background)",
                borderRadius: "6px",
            }}>
            {/* Icon */}
            <i className="codicon codicon-add" style={{ fontSize: "18px" }} />

            {/* Content */}
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "4px",
                    textAlign: "center",
                    maxWidth: "480px",
                }}>
                <h3
                    style={{
                        margin: 0,
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "var(--vscode-foreground)",
                    }}>
                    {t("capabilities.mcp.marketplace.submit")}
                </h3>
                <p style={{ fontSize: "13px", margin: 0, color: "var(--vscode-descriptionForeground)" }}>
                    <CapabilityRichText
                        parts={[
                            {
                                name: "tracker",
                                node: (
                                    <a href="https://github.com/TuvokYang/Dline/issues/new">
                                        {t("capabilities.mcp.marketplace.tracker")}
                                    </a>
                                ),
                            },
                        ]}
                        render={(slot) => t("capabilities.mcp.marketplace.submitHelp", { tracker: slot("tracker") })}
                    />
                </p>
            </div>
        </div>
    )
}

export default McpSubmitCard
