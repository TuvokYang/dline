import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import UserMessage from "../UserMessage"

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ checkpointManagerErrorMessage: undefined }),
}))

vi.mock("@/services/grpc-client", () => ({
    CheckpointsServiceClient: { checkpointRestore: vi.fn(async () => undefined) },
    FileServiceClient: {
        ifFileExistsRelativePath: vi.fn(async () => ({ value: false })),
        openFile: vi.fn(async () => undefined),
    },
}))

describe("UserMessage rendering", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("renders direct user input as bounded Markdown", () => {
        render(<UserMessage text={"# Direct heading\n\n- direct item"} />)

        const message = screen.getByTestId("direct-user-input")
        const body = screen.getByTestId("user-input-markdown-scroll")
        expect(message).toHaveAttribute("data-input-kind", "direct")
        expect(screen.getByRole("heading", { name: "Direct heading" })).toBeInTheDocument()
        expect(screen.getByText("direct item")).toBeInTheDocument()
        expect(body).toHaveClass("max-h-[min(30vh,320px)]", "overflow-y-auto")
    })

    it("renders delivered QueueInput with independent semantics and no internal guidance", () => {
        render(<UserMessage inputKind="queued" queuedInputMode="steering" text={"## 你好\n\n**queue emphasis**"} />)

        const message = screen.getByTestId("queued-user-input")
        const body = screen.getByTestId("queued-input-markdown-scroll")
        expect(message).toHaveAttribute("data-input-kind", "queued")
        expect(message).toHaveAttribute("data-queue-state", "delivered")
        expect(message).toHaveAttribute("data-queued-input-mode", "steering")
        expect(screen.getByText("Queued input")).toBeInTheDocument()
        expect(screen.getByText("· Steering")).toBeInTheDocument()
        expect(screen.getByRole("heading", { name: "你好" })).toBeInTheDocument()
        expect(screen.getByText("queue emphasis")).toBeInTheDocument()
        expect(body).toHaveClass("max-h-[min(30vh,320px)]", "overflow-y-auto")
        expect(message).not.toHaveTextContent("auxiliary alignment information")
        expect(message).not.toHaveTextContent("辅助对齐信息")
        expect(message.style.backgroundColor).toContain("--vscode-editorWidget-background")
    })
})
