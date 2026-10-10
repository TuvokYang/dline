import { SubagentInfo } from "@shared/proto/dline/file"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "../../services/grpc-client"
import SubagentRow from "./SubagentRow"

vi.mock("../../services/grpc-client", () => ({
    FileServiceClient: {
        deleteSubagentFile: vi.fn(async () => undefined),
        getApiProfiles: vi.fn(),
        getAvailableTools: vi.fn(),
        openFile: vi.fn(async () => undefined),
        updateSubagentConfig: vi.fn(async () => undefined),
    },
}))

const agent = SubagentInfo.create({
    name: "reviewer",
    description: "Reviews code",
    path: "C:\\workspace\\.agents\\subagents\\reviewer.yml",
    enabled: true,
    tools: ["read_file"],
    skills: ["systematic-debugging"],
    profile: "profile-a",
})

describe("SubagentRow", () => {
    beforeEach(() => {
        vi.mocked(FileServiceClient.getAvailableTools)
            .mockReset()
            .mockResolvedValue({
                groups: [
                    {
                        name: "Read-only",
                        tools: [
                            { name: "read_file", description: "Read files", isReadOnly: true },
                            { name: "search_files", description: "Search files", isReadOnly: true },
                        ],
                    },
                ],
            })
        vi.mocked(FileServiceClient.getApiProfiles)
            .mockReset()
            .mockResolvedValue({
                profiles: [
                    { id: "profile-a", name: "profile-a", enabled: true, usedFor: ["subagents"] },
                    { id: "profile-b", name: "profile-b", enabled: true, usedFor: ["subagents"] },
                ],
            })
        vi.mocked(FileServiceClient.updateSubagentConfig).mockClear()
    })

    it("does not let an older failed toggle clear a newer pending intent", async () => {
        let rejectFirst: ((error: Error) => void) | undefined
        const onToggle = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectFirst = reject
                    }),
            )
            .mockImplementation(() => new Promise<void>(() => {}))
        render(<SubagentRow agent={agent} isGlobal={true} onDelete={vi.fn()} onToggle={onToggle} />)
        const toggle = screen.getByRole("switch")

        fireEvent.click(toggle)
        fireEvent.click(toggle)
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute("data-state", "unchecked")
        expect(onToggle).toHaveBeenCalledTimes(3)

        await act(async () => {
            rejectFirst?.(new Error("first write failed"))
            await Promise.resolve()
        })
        expect(toggle).toHaveAttribute("data-state", "unchecked")
    })

    it("keeps list replacement intent off for profile updates and enables it for tool updates", async () => {
        const { container } = render(<SubagentRow agent={agent} isGlobal={false} onDelete={vi.fn()} onToggle={vi.fn()} />)

        const expandButton = container.querySelector("button")
        if (!expandButton) throw new Error("Subagent expand button was not rendered")
        fireEvent.click(expandButton)

        const profileSelect = await screen.findByRole("combobox")
        fireEvent.change(profileSelect, { target: { value: "profile-b" } })

        await waitFor(() => expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(1))
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                subagentPath: agent.path,
                profile: "profile-b",
                replaceTools: false,
                replaceSkills: false,
            }),
        )

        const checkboxes = await screen.findAllByRole("checkbox")
        expect(checkboxes).toHaveLength(2)
        fireEvent.click(checkboxes[1])

        await waitFor(() => expect(FileServiceClient.updateSubagentConfig).toHaveBeenCalledTimes(2))
        expect(FileServiceClient.updateSubagentConfig).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                subagentPath: agent.path,
                tools: ["read_file", "search_files"],
                replaceTools: true,
                replaceSkills: false,
            }),
        )
    })
})
