import { UiMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ApiErrorBox } from "./ApiErrorBox"
import { ApiFailureContent } from "./ApiFailureContent"
import { ChatUiText } from "./chat-view/components/ChatUiText"

interface ErrorRowProps {
    message: UiMessage
    errorType: "error" | "mistake_limit_reached" | "diff_error" | "clineignore_error"
    apiRequestFailedMessage?: string
    apiReqStreamingFailedMessage?: string
}

const ErrorRow = memo(({ message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage }: ErrorRowProps) => {
    const { t } = useUiTranslation()
    const rawApiError = apiRequestFailedMessage || apiReqStreamingFailedMessage

    const renderErrorContent = () => {
        switch (errorType) {
            case "error":
            case "mistake_limit_reached":
                if (rawApiError) return <ApiFailureContent error={rawApiError} />

                return (
                    <ApiErrorBox
                        error={message.text}
                        testId="error-message-box"
                        title={
                            errorType === "mistake_limit_reached"
                                ? t("chatRows.errors.taskNeedsAttention")
                                : t("chatRows.errors.error")
                        }
                    />
                )

            case "diff_error":
                return (
                    <div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
                        <div>{t("chatRows.errors.diffMismatch")}</div>
                    </div>
                )

            case "clineignore_error":
                return (
                    <div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
                        <div>
                            <ChatUiText
                                slots={{
                                    file: <code>.agentignore</code>,
                                    path: <code>{message.text}</code>,
                                }}
                                text={t("chatRows.errors.ignoredPath")}
                            />
                        </div>
                    </div>
                )

            default:
                return null
        }
    }

    // For diff_error and clineignore_error, we don't show the header separately
    if (errorType === "diff_error" || errorType === "clineignore_error") {
        return renderErrorContent()
    }

    // For other error types, show header + content
    return renderErrorContent()
})

export default ErrorRow
