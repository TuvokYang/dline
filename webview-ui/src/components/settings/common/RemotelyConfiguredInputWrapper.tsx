import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

export function RemotelyConfiguredInputWrapper({ hidden, children }: React.PropsWithChildren<{ hidden: boolean }>) {
    const { t } = useUiTranslation()
    return (
        <Tooltip>
            <TooltipContent hidden={hidden}>{t("settings.ui.managed")}</TooltipContent>
            <TooltipTrigger>{children}</TooltipTrigger>
        </Tooltip>
    )
}

export const LockIcon = () => <i className="codicon codicon-lock text-description text-sm" />
