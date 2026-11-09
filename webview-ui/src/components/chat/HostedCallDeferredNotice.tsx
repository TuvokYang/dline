import { ClockIcon } from "lucide-react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

interface HostedCallDeferredNoticeProps {
    action: "search" | "fetch"
    testId: string
}

/**
 * Explains a provider-hosted call the provider deferred behind local tool calls of the same response.
 * The call is not running yet, so the notice is static rather than a spinner: the provider runs it at the
 * start of the next request, once the local tool results are sent back.
 */
const HostedCallDeferredNotice = ({ action, testId }: HostedCallDeferredNoticeProps) => {
    const { t } = useUiTranslation()
    return (
        <div className="flex items-start gap-2 text-xs text-description" data-testid={testId}>
            <ClockIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            <span>{action === "search" ? t("chatRows.deferred.search") : t("chatRows.deferred.fetch")}</span>
        </div>
    )
}

export default HostedCallDeferredNotice
