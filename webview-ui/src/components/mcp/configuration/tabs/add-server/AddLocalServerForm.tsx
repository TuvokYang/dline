import { EmptyRequest } from "@shared/proto/dline/common"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import styled from "styled-components"
import { CapabilityRichText } from "@/components/agent-capabilities/CapabilityRichText"
import { LINKS } from "@/constants"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { McpServiceClient } from "@/services/grpc-client"

type AddLocalServerFormProps = {
    onServerAdded: () => void
}

const AddLocalServerForm = ({}: AddLocalServerFormProps) => {
    const { t } = useUiTranslation()
    return (
        <FormContainer>
            <div className="text-(--vscode-foreground)">
                <CapabilityRichText
                    parts={[{ name: "file", node: <code>mcp_settings.json</code> }]}
                    render={(slot) => t("capabilities.mcp.localHelp", { file: slot("file") })}
                />{" "}
                <VSCodeLink href={LINKS.DOCUMENTATION.LOCAL_MCP_SERVER_DOCS} style={{ display: "inline" }}>
                    {t("capabilities.mcp.learnMore")}
                </VSCodeLink>
            </div>

            <VSCodeButton
                appearance="primary"
                onClick={() => {
                    McpServiceClient.openMcpSettings(EmptyRequest.create({})).catch((error) => {
                        console.error("Error opening MCP settings:", error)
                    })
                }}
                style={{ width: "100%", marginBottom: "5px", marginTop: 8 }}>
                {t("capabilities.mcp.openSettings")}
            </VSCodeButton>
        </FormContainer>
    )
}

const FormContainer = styled.div`
	padding: 16px 20px;
	display: flex;
	flex-direction: column;
	gap: 8px;
`

export default AddLocalServerForm
