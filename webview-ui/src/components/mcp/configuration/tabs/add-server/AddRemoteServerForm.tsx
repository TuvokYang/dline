import { EmptyRequest } from "@shared/proto/dline/common"
import { AddRemoteMcpServerRequest, McpServers } from "@shared/proto/dline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { VSCodeButton, VSCodeLink, VSCodeRadio, VSCodeRadioGroup, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { LINKS } from "@/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { McpServiceClient } from "@/services/grpc-client"

type TransportType = "streamableHttp" | "sse"

type FormErrorKey =
    | "capabilities.mcp.nameRequired"
    | "capabilities.mcp.urlRequired"
    | "capabilities.mcp.invalidUrl"
    | "capabilities.mcp.addError"

const AddRemoteServerForm = ({ onServerAdded }: { onServerAdded: () => void }) => {
    const { t } = useUiTranslation()
    const [serverName, setServerName] = useState("")
    const [serverUrl, setServerUrl] = useState("")
    const [transportType, setTransportType] = useState<TransportType>("streamableHttp")
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState<{ key: FormErrorKey; diagnostics?: string } | null>(null)
    const { setMcpServers } = useExtensionState()

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()

        if (!serverName.trim()) {
            setError({ key: "capabilities.mcp.nameRequired" })
            return
        }

        if (!serverUrl.trim()) {
            setError({ key: "capabilities.mcp.urlRequired" })
            return
        }

        try {
            new URL(serverUrl)
        } catch (_err) {
            setError({ key: "capabilities.mcp.invalidUrl" })
            return
        }

        setError(null)
        setIsSubmitting(true)

        try {
            const servers: McpServers = await McpServiceClient.addRemoteMcpServer(
                AddRemoteMcpServerRequest.create({
                    serverName: serverName.trim(),
                    serverUrl: serverUrl.trim(),
                    transportType: transportType,
                }),
            )

            setIsSubmitting(false)

            const mcpServers = convertProtoMcpServersToMcpServers(servers.mcpServers)
            setMcpServers(mcpServers)

            setServerName("")
            setServerUrl("")
            onServerAdded()
        } catch (error) {
            setIsSubmitting(false)
            setError({ key: "capabilities.mcp.addError", diagnostics: error instanceof Error ? error.message : String(error) })
        }
    }

    return (
        <div className="p-4 px-5">
            <div className="text-(--vscode-foreground) mb-2">
                {t("capabilities.mcp.remoteHelp")}{" "}
                <VSCodeLink href={LINKS.DOCUMENTATION.REMOTE_MCP_SERVER_DOCS} style={{ display: "inline" }}>
                    {t("capabilities.mcp.learnMore")}
                </VSCodeLink>
            </div>

            <form onSubmit={handleSubmit}>
                <div className="mb-2">
                    <VSCodeTextField
                        aria-label={t("capabilities.mcp.serverName")}
                        className="w-full"
                        disabled={isSubmitting}
                        onChange={(e) => {
                            setServerName((e.target as HTMLInputElement).value)
                            setError(null)
                        }}
                        placeholder={t("capabilities.mcp.serverNamePlaceholder")}
                        value={serverName}>
                        {t("capabilities.mcp.serverName")}
                    </VSCodeTextField>
                </div>

                <div className="mb-2">
                    <VSCodeTextField
                        aria-label={t("capabilities.mcp.serverUrl")}
                        className="w-full mr-4"
                        disabled={isSubmitting}
                        onChange={(e) => {
                            setServerUrl((e.target as HTMLInputElement).value)
                            setError(null)
                        }}
                        placeholder="https://example.com/mcp-server"
                        value={serverUrl}>
                        {t("capabilities.mcp.serverUrl")}
                    </VSCodeTextField>
                </div>

                <div className="mb-3">
                    <label className={`block text-sm font-medium mb-2 ${isSubmitting ? "opacity-50" : ""}`}>
                        {t("capabilities.mcp.transport")}
                    </label>
                    <VSCodeRadioGroup
                        aria-label={t("capabilities.mcp.transport")}
                        disabled={isSubmitting}
                        onChange={(e) => {
                            const value = (e.target as HTMLInputElement).value as TransportType
                            setTransportType(value)
                        }}
                        value={transportType}>
                        <VSCodeRadio checked={transportType === "streamableHttp"} value="streamableHttp">
                            {t("capabilities.mcp.streamableHttp")}
                        </VSCodeRadio>
                        <VSCodeRadio checked={transportType === "sse"} value="sse">
                            {t("capabilities.mcp.sseLegacy")}
                        </VSCodeRadio>
                    </VSCodeRadioGroup>
                </div>

                {error && (
                    <div className="mb-3 text-(--vscode-errorForeground)" role="alert">
                        {t(error.key)}
                        {error.diagnostics && (
                            <details>
                                <summary>{t("capabilities.diagnostics")}</summary>
                                {error.diagnostics}
                            </details>
                        )}
                    </div>
                )}

                <VSCodeButton className="w-full" disabled={isSubmitting} type="submit">
                    {t(isSubmitting ? "capabilities.mcp.connecting" : "capabilities.mcp.addServer")}
                </VSCodeButton>

                <VSCodeButton
                    appearance="secondary"
                    onClick={() => {
                        McpServiceClient.openMcpSettings(EmptyRequest.create({})).catch((error) => {
                            console.error("Error opening MCP settings:", error)
                        })
                    }}
                    style={{ width: "100%", marginBottom: "5px", marginTop: 15 }}>
                    {t("capabilities.mcp.editConfiguration")}
                </VSCodeButton>
            </form>
        </div>
    )
}

export default AddRemoteServerForm
