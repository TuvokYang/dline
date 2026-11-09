import { McpResource, McpResourceTemplate } from "@shared/mcp"
import { CapabilityRichText } from "@/components/agent-capabilities/CapabilityRichText"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

type McpResourceRowProps = {
    item: McpResource | McpResourceTemplate
}

const McpResourceRow = ({ item }: McpResourceRowProps) => {
    const { t } = useUiTranslation()
    const hasUri = "uri" in item
    const uri = hasUri ? item.uri : item.uriTemplate

    return (
        <div
            key={uri}
            style={{
                padding: "3px 0",
            }}>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    marginBottom: "4px",
                }}>
                <span className={`codicon codicon-symbol-file`} style={{ marginRight: "6px" }} />
                <span style={{ fontWeight: 500, wordBreak: "break-all" }}>{uri}</span>
            </div>
            <div
                style={{
                    fontSize: "12px",
                    opacity: 0.8,
                    margin: "4px 0",
                }}>
                {item.name && item.description
                    ? `${item.name}: ${item.description}`
                    : !item.name && item.description
                      ? item.description
                      : !item.description && item.name
                        ? item.name
                        : t("capabilities.mcp.noDescription")}
            </div>
            <div
                style={{
                    fontSize: "12px",
                }}>
                <CapabilityRichText
                    parts={[
                        {
                            name: "type",
                            node: (
                                <code
                                    style={{
                                        color: "var(--vscode-textPreformat-foreground)",
                                        background: "var(--vscode-textPreformat-background)",
                                        padding: "1px 4px",
                                        borderRadius: "3px",
                                    }}>
                                    {item.mimeType || t("capabilities.mcp.unknownType")}
                                </code>
                            ),
                        },
                    ]}
                    render={(slot) => t("capabilities.mcp.returns", { type: slot("type") })}
                />
            </div>
        </div>
    )
}

export default McpResourceRow
