// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import { fileNameFromPath, OpenFilePathLink } from "./OpenFilePathLink"

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        openFile: vi.fn(async () => ({})),
    },
}))

describe("OpenFilePathLink", () => {
    beforeEach(() => {
        vi.mocked(FileServiceClient.openFile).mockClear()
    })

    it("derives labels from Windows and Unix paths", () => {
        expect(fileNameFromPath("C:\\Temp\\background-1.log")).toBe("background-1.log")
        expect(fileNameFromPath("/tmp/background-2.log")).toBe("background-2.log")
    })

    it("opens the complete path while displaying only its basename", () => {
        const filePath = "C:\\Users\\yyk\\AppData\\Local\\Temp\\cline\\background-1.log"
        render(<OpenFilePathLink filePath={filePath} label="Output log:" />)

        expect(screen.getByText("background-1.log")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Open log file background-1.log" }))

        expect(FileServiceClient.openFile).toHaveBeenCalledOnce()
        expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: filePath }))
    })
})
