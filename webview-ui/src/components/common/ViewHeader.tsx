import { Button } from "@/components/ui/button"
import type { UiMessageKey } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { getEnvironmentColor } from "@/utils/environmentColors"
import type { Environment } from "../../../../src/shared/config-types"

/** Environment names are product display text; the environment value itself is unchanged. */
const ENV_NAME_KEYS: Record<Environment, Extract<UiMessageKey, `shell.chrome.environment.${string}`>> = {
    production: "shell.chrome.environment.production",
    staging: "shell.chrome.environment.staging",
    local: "shell.chrome.environment.local",
    selfHosted: "shell.chrome.environment.selfHosted",
}

type ViewHeaderProps = {
    /** Already-translated view title. Callers own the text so each view keeps its own keys. */
    title: string
    onDone: () => void | Promise<void>
    doneDisabled?: boolean
    doneLabel?: string
    showEnvironmentSuffix?: boolean
    environment?: Environment
}

const ViewHeader = ({ title, onDone, doneDisabled = false, doneLabel, showEnvironmentSuffix, environment }: ViewHeaderProps) => {
    const { t } = useUiTranslation()
    const showSubtext = showEnvironmentSuffix && environment && environment !== "production"
    const environmentName = environment ? t(ENV_NAME_KEYS[environment]) : ""
    const titleColor = getEnvironmentColor(environment)

    return (
        <div className="flex justify-between items-center py-2.5 px-5 mb-[17px]">
            <div className="relative">
                <h3 className="m-0 text-lg font-normal" style={{ color: titleColor }}>
                    {title}
                </h3>
                {showSubtext && (
                    <span className="absolute left-0 top-8 -translate-y-1 text-xs text-description whitespace-nowrap">
                        {t("shell.chrome.environmentSuffix", { environment: environmentName })}
                    </span>
                )}
            </div>
            <Button disabled={doneDisabled} onClick={() => void onDone()} size="header">
                {doneLabel ?? t("shell.chrome.done")}
            </Button>
        </div>
    )
}

export default ViewHeader
