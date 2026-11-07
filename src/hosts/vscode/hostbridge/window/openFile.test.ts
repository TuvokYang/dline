import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { OpenFileRequest } from "@/shared/proto/dline/host/window"
import { openFile } from "./openFile"

describe("window.openFile host bridge", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("passes explicit editor options so a custom editor never reads undefined options", async () => {
        const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async () => undefined)

        await openFile(OpenFileRequest.create({ filePath: "C:\\images\\screenshot.png" }))

        expect(executeCommand).toHaveBeenCalledTimes(1)
        const [command, uri, options] = executeCommand.mock.calls[0]!
        expect(command).toBe("vscode.open")
        expect(uri).toEqual(expect.objectContaining({ fsPath: "C:\\images\\screenshot.png" }))
        // The generic open command hands this argument to a custom editor's
        // input. VS Code dereferences it while applying navigation options, so an
        // omitted options object throws inside the workbench instead of opening.
        expect(options).toEqual({ preview: false, preserveFocus: false })
    })
})
