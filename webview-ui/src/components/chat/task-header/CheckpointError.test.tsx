import { EmptyRequest } from "@shared/proto/dline/common"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CheckpointsServiceClient } from "@/services/grpc-client"
import { CheckpointError } from "./CheckpointError"

vi.mock("@/services/grpc-client", () => ({
    CheckpointsServiceClient: {
        retryCheckpointInitialization: vi.fn(),
    },
}))

describe("CheckpointError", () => {
    beforeEach(() => {
        vi.mocked(CheckpointsServiceClient.retryCheckpointInitialization).mockReset()
    })

    it("does not render without a checkpoint error", () => {
        const { container } = render(
            <CheckpointError checkpointManagerErrorMessage={undefined} handleCheckpointSettingsClick={vi.fn()} />,
        )

        expect(container).toBeEmptyDOMElement()
    })

    it("retries checkpoint initialization through the typed RPC", async () => {
        vi.mocked(CheckpointsServiceClient.retryCheckpointInitialization).mockResolvedValue({ value: true })
        render(
            <CheckpointError
                checkpointManagerErrorMessage="Checkpoint shadow initialization failed."
                handleCheckpointSettingsClick={vi.fn()}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Retry Checkpoints" }))

        await waitFor(() => {
            expect(CheckpointsServiceClient.retryCheckpointInitialization).toHaveBeenCalledWith(EmptyRequest.create({}))
        })
        expect(CheckpointsServiceClient.retryCheckpointInitialization).toHaveBeenCalledOnce()
    })

    it("disables the action while retrying and restores it after a failed request", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        let rejectRequest: ((reason?: unknown) => void) | undefined
        const pendingRequest = new Promise<{ value: boolean }>((_resolve, reject) => {
            rejectRequest = reject
        })
        vi.mocked(CheckpointsServiceClient.retryCheckpointInitialization).mockReturnValue(pendingRequest)
        render(
            <CheckpointError
                checkpointManagerErrorMessage="Checkpoint shadow initialization failed."
                handleCheckpointSettingsClick={vi.fn()}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Retry Checkpoints" }))

        expect(screen.getByRole("button", { name: "Retry Checkpoints" })).toBeDisabled()
        expect(screen.getByText("Retrying…")).toBeInTheDocument()

        rejectRequest?.(new Error("retry failed"))
        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Retry Checkpoints" })).toBeEnabled()
        })
        expect(consoleError).toHaveBeenCalledWith("Checkpoint initialization retry failed:", expect.any(Error))
    })
})
