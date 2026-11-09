import { UpdateSettingsRequest, UserOrganization } from "@shared/proto/index.dline"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useRef } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { StateServiceClient } from "@/services/grpc-client"
import { isAdminOrOwner } from "./helpers"

export function RemoteConfigToggle({ activeOrganization }: { activeOrganization: UserOrganization | null }) {
    const { t } = useUiTranslation()
    const { optOutOfRemoteConfig } = useExtensionState()
    const hadOptedOutOfRemoteConfig = useRef(optOutOfRemoteConfig)

    // If there is no active org but the user had already opted out, keep displaying the toggle
    if (!hadOptedOutOfRemoteConfig.current && activeOrganization && !isAdminOrOwner(activeOrganization)) {
        return null
    }

    const onUpdateToggle = async (value: boolean) => {
        await StateServiceClient.updateSettings(
            UpdateSettingsRequest.create({
                optOutOfRemoteConfig: value,
            }),
        )
    }

    return (
        <VSCodeCheckbox
            checked={optOutOfRemoteConfig}
            onChange={(e: any) => {
                const isChecked = e.target.checked === true

                onUpdateToggle(isChecked)
            }}>
            {t("shell.account.optOutRemoteConfig")}
        </VSCodeCheckbox>
    )
}
