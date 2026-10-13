import { UiMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import { ApiErrorBox } from "./ApiErrorBox"
import { ApiFailureContent } from "./ApiFailureContent"

interface ErrorRowProps {
    message: UiMessage
    errorType: "error" | "mistake_limit_reached" | "diff_error" | "clineignore_error"
    apiRequestFailedMessage?: string
    apiReqStreamingFailedMessage?: string
}

const ErrorRow = memo(({ message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage }: ErrorRowProps) => {
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
                        title={errorType === "mistake_limit_reached" ? "Task Needs Attention" : "Error"}
                    />
                )

            case "diff_error":
                return (
                    <div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
                        <div>The model used search patterns that don't match anything in the file. Retrying...</div>
                    </div>
                )

            case "clineignore_error":
                return (
                    <div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
                        <div>
                            Dline tried to access <code>{message.text}</code> which is blocked by the <code>.agentignore</code>
                            file.
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
