import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import { resetResourceThumbnailsForTesting } from "../input/semantic-composer/resource-thumbnails"
import UserMessage from "../UserMessage"

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ checkpointManagerErrorMessage: undefined }),
}))

vi.mock("@/services/grpc-client", () => ({
    CheckpointsServiceClient: { checkpointRestore: vi.fn(async () => undefined) },
    FileServiceClient: {
        ifFileExistsRelativePath: vi.fn(async () => ({ value: false })),
        openFile: vi.fn(async () => undefined),
        openInputResource: vi.fn(async () => ({})),
        readInputResourceImage: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" })),
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

    // A sent row records only each resource's name, so the chip reads its kind from the name.
    it("draws a sent resource as its chip inside the row's Markdown", () => {
        render(
            <UserMessage
                submittedInputs={[
                    {
                        segments: [
                            { text: "**see** ", role: "text", active: false },
                            { text: "[shot.png]", role: "resource", active: true },
                            { text: " and ", role: "text", active: false },
                            { text: "[notes.md]", role: "resource", active: true },
                        ],
                    },
                ]}
                text="**see** [shot.png] and [notes.md]"
            />,
        )

        const body = screen.getByTestId("user-input-markdown-scroll")
        expect(screen.getByText("see").tagName).toBe("STRONG")
        const chips = Array.from(body.querySelectorAll("[data-resource-chip]"))
        expect(chips.map((chip) => chip.querySelector(".composer-chip__label")?.textContent)).toEqual(["shot.png", "notes.md"])
        expect(chips[0].querySelector(".codicon-file-media")).not.toBeNull()
        expect(chips[1].querySelector(".codicon-note")).not.toBeNull()
        expect(body).not.toHaveTextContent("[shot.png]")

        // Reading a chip is not a request to edit the message.
        fireEvent.click(chips[0])
        expect(screen.queryByRole("textbox")).toBeNull()
    })

    it("opens a sent resource the task still holds, and leaves a draft-owned one static", () => {
        const taskImage = {
            resourceId: "res-1",
            expectedContentHash: "sha256:abc",
            mediaType: "image/png",
            byteLength: 42,
            owner: { kind: "task" as const, taskId: "task-1" },
            generation: 1,
        }
        const draftFile = {
            ...taskImage,
            resourceId: "res-2",
            mediaType: "text/plain",
            owner: { kind: "draft" as const, draftId: "d" },
        }
        render(
            <UserMessage
                submittedInputs={[
                    {
                        segments: [
                            { text: "[clip]", role: "resource", active: true, resource: taskImage },
                            { text: " ", role: "text", active: false },
                            { text: "[notes]", role: "resource", active: true, resource: draftFile },
                        ],
                    },
                ]}
                text="[clip] [notes]"
            />,
        )

        // The recorded media type, not the extensionless name, makes the first chip an image.
        const open = screen.getByRole("button", { name: /clip/ })
        expect(open.querySelector(".codicon-file-media")).not.toBeNull()
        fireEvent.click(open)
        expect(FileServiceClient.openInputResource).toHaveBeenCalledTimes(1)
        expect(vi.mocked(FileServiceClient.openInputResource).mock.calls[0][0]).toMatchObject({
            draftId: "",
            ref: { resourceId: "res-1", owner: { taskId: "task-1" } },
        })
        expect(screen.queryByRole("textbox")).toBeNull()

        expect(screen.queryByRole("button", { name: /notes/ })).toBeNull()
        expect(screen.getByText("notes").closest("[data-resource-chip]")).toHaveClass("composer-chip--static")
    })

    it("draws a sent image chip with the thumbnail of its stored bytes", async () => {
        resetResourceThumbnailsForTesting()
        URL.createObjectURL = vi.fn(() => "blob:sent-thumbnail")
        const taskImage = {
            resourceId: "res-1",
            expectedContentHash: "sha256:sent",
            mediaType: "image/png",
            byteLength: 3,
            owner: { kind: "task" as const, taskId: "task-1" },
            generation: 1,
        }
        render(
            <UserMessage
                submittedInputs={[{ segments: [{ text: "[shot.png]", role: "resource", active: true, resource: taskImage }] }]}
                text="[shot.png]"
            />,
        )

        await waitFor(() =>
            expect(document.querySelector("img.composer-chip__thumbnail")).toHaveAttribute("src", "blob:sent-thumbnail"),
        )
        expect(vi.mocked(FileServiceClient.readInputResourceImage).mock.calls[0][0]).toMatchObject({
            draftId: "",
            ref: { resourceId: "res-1", owner: { taskId: "task-1" } },
        })
    })
})
