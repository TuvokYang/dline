import { EmptyRequest } from "@shared/proto/dline/common"
import { useMemo, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CheckpointsServiceClient } from "@/services/grpc-client"

interface CheckpointErrorProps {
    checkpointManagerErrorMessage?: string
    handleCheckpointSettingsClick: () => void
}
export const CheckpointError: React.FC<CheckpointErrorProps> = ({
    checkpointManagerErrorMessage,
    handleCheckpointSettingsClick,
}) => {
    const [isRetrying, setIsRetrying] = useState(false)
    const messages = useMemo(() => {
        const message = checkpointManagerErrorMessage?.replace(/disabling checkpoints\.$/, "")
        const showDisableButton =
            checkpointManagerErrorMessage?.endsWith("disabling checkpoints.") ||
            checkpointManagerErrorMessage?.includes("multi-root workspaces")
        const showGitInstructions = checkpointManagerErrorMessage?.includes("Git must be installed to use checkpoints.")
        return { message, showDisableButton, showGitInstructions }
    }, [checkpointManagerErrorMessage])

    if (!checkpointManagerErrorMessage) {
        return null
    }

    const handleRetry = async () => {
        setIsRetrying(true)
        try {
            await CheckpointsServiceClient.retryCheckpointInitialization(EmptyRequest.create({}))
        } catch (error) {
            console.error("Checkpoint initialization retry failed:", error)
        } finally {
            setIsRetrying(false)
        }
    }

    return (
        <div className="flex items-center justify-center w-full">
            <Alert title={messages.message} variant="danger">
                <AlertDescription className="flex gap-2 justify-end">
                    <Button aria-label="Retry Checkpoints" disabled={isRetrying} onClick={handleRetry} variant="ghost">
                        {isRetrying ? "Retrying…" : "Retry Checkpoints"}
                    </Button>
                    {messages.showDisableButton && (
                        <Button aria-label="Disable Checkpoints" onClick={handleCheckpointSettingsClick} variant="ghost">
                            Disable Checkpoints
                        </Button>
                    )}
                    {messages.showGitInstructions && (
                        <a className="text-link underline" href="https://docs.dline.cc/core-workflows/checkpoints/">
                            See instructions
                        </a>
                    )}
                </AlertDescription>
            </Alert>
        </div>
    )
}
