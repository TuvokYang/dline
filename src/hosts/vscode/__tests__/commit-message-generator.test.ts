import { afterEach, describe, it, vi } from "vitest"
import "should"
// sinon import removed: using vitest globals
import * as gitUtils from "@/utils/git"
import { getGitDiffStagedFirst } from "../commit-message-generator"

describe("commit-message-generator", () => {
    describe("getGitDiffStagedFirst", () => {
        afterEach(() => {
            vi.restoreAllMocks()
        })

        it("should return staged changes when they exist", async () => {
            const stub = vi.spyOn(gitUtils, "getGitDiff")
            stub.mockImplementation((cwd: string, stagedOnly?: boolean) => {
                if (cwd === "/repo" && stagedOnly === true) return Promise.resolve("staged diff content")
                return Promise.resolve("")
            })

            const result = await getGitDiffStagedFirst("/repo")
            result.should.equal("staged diff content")
            stub.mock.calls.length.should.equal(1)
            stub.mock.calls[0].should.deepEqual(["/repo", true])
        })

        it("should fall back to all changes when no staged changes exist", async () => {
            const stub = vi.spyOn(gitUtils, "getGitDiff")
            stub.mockImplementation((cwd: string, stagedOnly?: boolean) => {
                if (cwd === "/repo" && stagedOnly === true)
                    return Promise.reject(new Error("No changes in workspace for commit message"))
                if (cwd === "/repo" && stagedOnly === false) return Promise.resolve("all diff content")
                return Promise.resolve("")
            })

            const result = await getGitDiffStagedFirst("/repo")
            result.should.equal("all diff content")
            stub.mock.calls.length.should.equal(2)
            stub.mock.calls[0].should.deepEqual(["/repo", true])
            stub.mock.calls[1].should.deepEqual(["/repo", false])
        })

        it("should propagate error when both staged and all changes fail", async () => {
            const stub = vi.spyOn(gitUtils, "getGitDiff")
            stub.mockImplementation((cwd: string, stagedOnly?: boolean) => {
                if (cwd === "/repo" && stagedOnly === true) return Promise.reject(new Error("No changes"))
                if (cwd === "/repo" && stagedOnly === false)
                    return Promise.reject(new Error("No changes in workspace for commit message"))
                return Promise.resolve("")
            })

            let error: Error | undefined
            try {
                await getGitDiffStagedFirst("/repo")
            } catch (e) {
                error = e as Error
            }
            ;(error !== undefined).should.be.true()
            error?.message.should.equal("No changes in workspace for commit message")
        })
    })
})
