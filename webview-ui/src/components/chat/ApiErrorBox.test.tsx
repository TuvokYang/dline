import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import { ApiErrorBox } from "./ApiErrorBox"

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        copyToClipboard: vi.fn(async () => undefined),
    },
}))

describe("ApiErrorBox", () => {
    beforeEach(() => {
        vi.mocked(FileServiceClient.copyToClipboard).mockClear()
    })

    it("renders structured provider error fields without exposing the serialized payload", () => {
        const serializedError = JSON.stringify({
            message: "500 No scripted E2E response remains for openai-compatible-chat",
            status: 500,
            request_id: "req_e2e_123",
            code: "e2e_mock_queue_exhausted",
            modelId: "dline-e2e-model",
            providerId: "openai",
            details: {
                message: "No scripted E2E response remains for openai-compatible-chat",
                type: "e2e_mock_error",
                code: "e2e_mock_queue_exhausted",
                retry_after: 2,
            },
        })

        const { container } = render(<ApiErrorBox error={serializedError} />)

        expect(screen.getAllByText("e2e_mock_queue_exhausted")).toHaveLength(1)
    })

    it("copies the visible structured API error from the title action", async () => {
        const serializedError = JSON.stringify({
            message: "500 No scripted E2E response remains for openai-compatible-chat",
            status: 500,
            request_id: "req_e2e_123",
            code: "e2e_mock_queue_exhausted",
            modelId: "dline-e2e-model",
            providerId: "openai",
            details: {
                message: "No scripted E2E response remains for openai-compatible-chat",
                type: "e2e_mock_error",
                target: "openai-compatible-chat",
                retryable: true,
            },
        })

        render(<ApiErrorBox error={serializedError} />)
        fireEvent.click(screen.getByRole("button", { name: "Copy error" }))

        await waitFor(() =>
            expect(FileServiceClient.copyToClipboard).toHaveBeenCalledWith(
                expect.objectContaining({
                    value: [
                        "API Request Failed",
                        "",
                        "No scripted E2E response remains for openai-compatible-chat",
                        "",
                        "Provider: openai",
                        "Model: dline-e2e-model",
                        "HTTP status: 500",
                        "Error code: e2e_mock_queue_exhausted",
                        "Request ID: req_e2e_123",
                        "",
                        "Details",
                        "Type: e2e_mock_error",
                        "Target: openai-compatible-chat",
                        "Retryable: true",
                    ].join("\n"),
                }),
            ),
        )
    })

    it("renders provider and model for an error without status or code", () => {
        const serializedError = JSON.stringify({
            message: "Connection error.",
            modelId: "claude-sonnet-4-6",
            providerId: "anthropic",
        })

        render(<ApiErrorBox error={serializedError} />)

        expect(screen.queryByTestId("api-error-box-status")).not.toBeInTheDocument()
        expect(screen.queryByTestId("api-error-box-code")).not.toBeInTheDocument()
    })

    it("renders a plain error message without manufacturing metadata", () => {
        render(<ApiErrorBox error="Command failed" title="Error" />)

        expect(screen.getByText("Error")).toBeInTheDocument()
        expect(screen.queryByTestId("api-error-box-provider")).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Copy error" })).not.toBeInTheDocument()
    })

    it("renders a provider detail string instead of object coercion", () => {
        render(<ApiErrorBox error={JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" })} />)

        expect(screen.queryByText("[object Object]")).not.toBeInTheDocument()
    })

    it("renders a nested provider detail message and its diagnostic fields", () => {
        render(
            <ApiErrorBox
                error={JSON.stringify({
                    detail: {
                        message: "No tool output found for function call fc_missing_result.",
                        type: "invalid_request_error",
                        param: "input",
                    },
                })}
            />,
        )

        expect(screen.queryByText("[object Object]")).not.toBeInTheDocument()
    })
})
