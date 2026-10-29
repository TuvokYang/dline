import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    execFile: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }))

import { listCondaEnvironments, parseCondaEnvironmentNames } from "./listCondaEnvironments"

describe("listCondaEnvironments", () => {
    beforeEach(() => {
        mocks.execFile.mockReset()
    })

    it("maps conda JSON paths to sorted unique names", () => {
        expect(
            parseCondaEnvironmentNames(
                JSON.stringify({
                    envs: ["C:\\Users\\test\\envs\\zeta", "/opt/conda/envs/alpha", "/opt/conda/envs/alpha/"],
                    root_prefix: "C:\\Users\\test\\miniconda3",
                }),
            ),
        ).toEqual(["alpha", "zeta"])
    })

    it("executes conda in the extension environment", async () => {
        mocks.execFile.mockImplementation((...args: unknown[]) => {
            const callback = args.at(-1) as (error: null, result: { stdout: string; stderr: string }) => void
            callback(null, {
                stdout: JSON.stringify({
                    envs: ["C:\\conda", "C:\\envs\\dline"],
                    envs_details: {
                        "C:\\conda": { active: true, base: true, name: "base" },
                        "C:\\envs\\dline": { base: false, name: "dline" },
                    },
                }),
                stderr: "",
            })
        })

        await expect(listCondaEnvironments({} as never)).resolves.toMatchObject({ values: ["base", "dline"] })
        expect(mocks.execFile).toHaveBeenCalledWith(
            process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "conda",
            process.platform === "win32" ? ["/d", "/s", "/c", "conda info --envs --json"] : ["info", "--envs", "--json"],
            expect.objectContaining({ timeout: 10_000, windowsHide: true }),
            expect.any(Function),
        )
    })

    it("returns an empty list when conda is unavailable", async () => {
        mocks.execFile.mockImplementation((...args: unknown[]) => {
            const callback = args.at(-1) as (error: Error) => void
            callback(new Error("conda not found"))
        })

        await expect(listCondaEnvironments({} as never)).resolves.toMatchObject({ values: [] })
    })
})
