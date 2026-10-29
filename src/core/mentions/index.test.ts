import * as extractTextModule from "@integrations/misc/extract-text"
import type { MentionReference } from "@shared/input-semantics/mention-reference"
import * as gitModule from "@utils/git"
import { expect } from "chai"
import * as fs from "fs"
import * as isBinaryFileModule from "isbinaryfile"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import * as terminalModule from "@/hosts/vscode/terminal/get-latest-output"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { type MentionResolutionEnvironment, resolveMention } from "."

describe("resolveMention", () => {
    let urlContentFetcherStub: any
    let fileContextTrackerStub: any
    let fsStatStub: any
    let fsReaddirStub: any
    let extractTextStub: any
    let isBinaryFileStub: any
    let getLatestTerminalOutputStub: any
    let getWorkingStateStub: any
    let getCommitInfoStub: any
    let showMessageStub: any

    const cwd = "/test/project"
    const file = (ref: string, workspaceHint?: string): MentionReference => ({
        kind: "file",
        ref,
        ...(workspaceHint ? { workspaceHint } : {}),
    })

    function environment(overrides: Partial<MentionResolutionEnvironment> = {}): MentionResolutionEnvironment {
        return { cwd, urlContentFetcher: urlContentFetcherStub, ...overrides }
    }

    beforeEach(() => {
        setVscodeHostProviderMock()
        urlContentFetcherStub = {
            launchBrowser: vi.fn().mockResolvedValue(undefined),
            closeBrowser: vi.fn().mockResolvedValue(undefined),
            urlToMarkdown: vi.fn().mockResolvedValue("# Example Website\n\nContent here"),
        }
        fileContextTrackerStub = { trackFileContext: vi.fn().mockResolvedValue(undefined) }

        fsStatStub = vi.spyOn(fs.promises, "stat")
        fsReaddirStub = vi.spyOn(fs.promises, "readdir")
        vi.spyOn(fs.promises, "realpath").mockImplementation(async (filePath) => String(filePath))

        extractTextStub = vi.spyOn(extractTextModule, "extractTextFromFile")
        isBinaryFileStub = vi.spyOn(isBinaryFileModule, "isBinaryFile")
        getLatestTerminalOutputStub = vi.spyOn(terminalModule, "getLatestTerminalOutput")
        getWorkingStateStub = vi.spyOn(gitModule, "getWorkingState")
        getCommitInfoStub = vi.spyOn(gitModule, "getCommitInfo")
        showMessageStub = vi.spyOn(HostProvider.window, "showMessage")
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe("File mentions", () => {
        it("labels the file inline and appends its content", async () => {
            fsStatStub.mockResolvedValue({ isFile: () => true, isDirectory: () => false })
            isBinaryFileStub.mockResolvedValue(false)
            extractTextStub.mockResolvedValue("console.log('Hello World');")

            const result = await resolveMention(
                file("/src/index.ts"),
                environment({ fileContextTracker: fileContextTrackerStub }),
            )

            expect(result).to.equal(`'src/index.ts' (see below for file content)

<file_content path="src/index.ts">
console.log('Hello World');
</file_content>`)
            expect(fileContextTrackerStub.trackFileContext.mock.calls).to.deep.equal([["src/index.ts", "file_mentioned"]])
        })

        it("resolves a path with spaces from its unquoted typed reference", async () => {
            fsStatStub.mockResolvedValue({ isFile: () => true, isDirectory: () => false })
            isBinaryFileStub.mockResolvedValue(false)
            extractTextStub.mockResolvedValue("console.log('Hello World');")

            const result = await resolveMention(file("/path with spaces/file.txt"), environment())

            expect(result).to.equal(`'path with spaces/file.txt' (see below for file content)

<file_content path="path with spaces/file.txt">
console.log('Hello World');
</file_content>`)
        })

        it("does not display binary content", async () => {
            fsStatStub.mockResolvedValue({ isFile: () => true, isDirectory: () => false })
            isBinaryFileStub.mockResolvedValue(true)

            const result = await resolveMention(file("/image.png"), environment())

            expect(result).to.equal(`'image.png' (see below for file content)

<file_content path="image.png">
(Binary file, unable to display content)
</file_content>`)
        })

        it("reports a read error in place of the content", async () => {
            fsStatStub.mockRejectedValue(new Error("ENOENT: no such file or directory"))

            const result = await resolveMention(file("/missing.txt"), environment())

            expect(result).to.equal(`'missing.txt' (see below for file content)

<file_content path="missing.txt">
Error fetching content: Failed to access path "missing.txt": ENOENT: no such file or directory
</file_content>`)
        })

        it("rejects a path that escapes every workspace root", async () => {
            const result = await resolveMention(file("/../outside-secret.txt"), environment())

            expect(result).to.contain('Access denied: path "../outside-secret.txt" is outside the workspace')
            expect(fsStatStub.mock.calls).to.have.length(0)
            expect(extractTextStub.mock.calls).to.have.length(0)
        })

        it("honors the caller path access policy before reading a file", async () => {
            const pathAccessPolicy = {
                validateFileAccess: vi.fn(() => false),
                validateDirectoryAccess: vi.fn(() => true),
            }

            const result = await resolveMention(
                file("/ignored.txt"),
                environment({ fileContextTracker: fileContextTrackerStub, pathAccessPolicy }),
            )

            expect(result).to.contain('Access denied by workspace policy: "ignored.txt"')
            expect(pathAccessPolicy.validateFileAccess.mock.calls).to.deep.equal([["ignored.txt", cwd]])
            expect(fsStatStub.mock.calls).to.have.length(0)
            expect(fileContextTrackerStub.trackFileContext.mock.calls).to.have.length(0)
        })

        it("never expands the workspace root", async () => {
            const result = await resolveMention({ kind: "folder", ref: "/" }, environment())

            expect(result).to.equal("'' (see below for folder content)")
            expect(fsStatStub.mock.calls).to.have.length(0)
        })
    })

    describe("Folder mentions", () => {
        it("lists the folder and appends the text of its files", async () => {
            fsStatStub.mockResolvedValue({ isFile: () => false, isDirectory: () => true })
            fsReaddirStub.mockResolvedValue([
                { name: "index.ts", isFile: () => true, isDirectory: () => false },
                { name: "utils", isFile: () => false, isDirectory: () => true },
                { name: "README.md", isFile: () => true, isDirectory: () => false },
            ])
            isBinaryFileStub.mockResolvedValue(false)
            extractTextStub.mockResolvedValueOnce("export const main = () => {};").mockResolvedValue("# Source Code")

            const result = await resolveMention({ kind: "folder", ref: "/src/" }, environment())

            expect(result).to.equal(`'src/' (see below for folder content)

<folder_content path="src/">
├── index.ts
├── utils/
└── README.md

<file_content path="src/index.ts">
export const main = () => {};
</file_content>

<file_content path="src/README.md">
# Source Code
</file_content>
</folder_content>`)
        })
    })

    describe("URL mentions", () => {
        const url: MentionReference = { kind: "url", ref: "https://example.com" }

        it("fetches the site and closes the browser", async () => {
            const result = await resolveMention(url, environment())

            expect(result).to.equal(`'https://example.com' (see below for site content)

<url_content url="https://example.com">
# Example Website

Content here
</url_content>`)
            expect(urlContentFetcherStub.urlToMarkdown.mock.calls).to.deep.equal([["https://example.com"]])
            expect(urlContentFetcherStub.closeBrowser.mock.calls).to.have.length(1)
        })

        it("reports a browser launch error", async () => {
            urlContentFetcherStub.launchBrowser.mockRejectedValue(new Error("Browser launch failed"))

            const result = await resolveMention(url, environment())

            expect(result).to.equal(`'https://example.com' (see below for site content)

<url_content url="https://example.com">
Error fetching content: Browser launch failed
</url_content>`)
            expect(showMessageStub.mock.calls.length > 0).to.be.true
        })

        it("reports a fetch error and still closes the browser", async () => {
            urlContentFetcherStub.urlToMarkdown.mockRejectedValue(new Error("Network error"))

            const result = await resolveMention(url, environment())

            expect(result).to.equal(`'https://example.com' (see below for site content)

<url_content url="https://example.com">
Error fetching content: Network error
</url_content>`)
            expect(showMessageStub.mock.calls.length > 0).to.be.true
            expect(urlContentFetcherStub.closeBrowser.mock.calls).to.have.length(1)
        })
    })

    describe("Workspace state mentions", () => {
        it("appends the latest terminal output", async () => {
            getLatestTerminalOutputStub.mockResolvedValue("$ npm test\nAll tests passed!")

            const result = await resolveMention({ kind: "terminal", ref: "terminal" }, environment())

            expect(result).to.equal(`Terminal Output (see below for output)

<terminal_output>
$ npm test
All tests passed!
</terminal_output>`)
        })

        it("appends the working directory changes", async () => {
            getWorkingStateStub.mockResolvedValue("M  src/index.ts\nA  src/new-file.ts")

            const result = await resolveMention({ kind: "git_changes", ref: "git-changes" }, environment())

            expect(result).to.equal(`Working directory changes (see below for details)

<git_working_state>
M  src/index.ts
A  src/new-file.ts
</git_working_state>`)
            expect(getWorkingStateStub.mock.calls).to.deep.equal([[cwd]])
        })

        it("appends the named commit", async () => {
            getCommitInfoStub.mockResolvedValue("commit abcdef1234567890\nAuthor: Test")

            const result = await resolveMention({ kind: "git_commit", ref: "abcdef1234567890" }, environment())

            expect(result).to.equal(`Git commit 'abcdef1234567890' (see below for commit info)

<git_commit hash="abcdef1234567890">
commit abcdef1234567890
Author: Test
</git_commit>`)
        })

        it.each([
            [
                { kind: "terminal", ref: "terminal" } as const,
                "<terminal_output>\nError fetching terminal output: Terminal error\n</terminal_output>",
            ],
            [
                { kind: "git_changes", ref: "git-changes" } as const,
                "<git_working_state>\nError fetching working state: Git state error\n</git_working_state>",
            ],
            [
                { kind: "git_commit", ref: "abc1234567" } as const,
                '<git_commit hash="abc1234567">\nError fetching commit info: Commit error\n</git_commit>',
            ],
        ])("reports a %o failure in place of its content", async (reference, block) => {
            getLatestTerminalOutputStub.mockRejectedValue(new Error("Terminal error"))
            getWorkingStateStub.mockRejectedValue(new Error("Git state error"))
            getCommitInfoStub.mockRejectedValue(new Error("Commit error"))

            const result = await resolveMention(reference, environment())

            expect(result.endsWith(`\n\n${block}`)).to.equal(true)
        })
    })

    describe("Multiroot workspace mentions", () => {
        const roots = [
            { name: "frontend", path: "/test/frontend" },
            { name: "backend", path: "/test/backend" },
        ]
        const workspaceManager = () =>
            ({
                getRoots: vi.fn().mockReturnValue(roots),
                getRootByName: vi.fn((name: string) => roots.find((root) => root.name === name)),
            }) as any

        it("reads a workspace-prefixed file only from the named root", async () => {
            fsStatStub.mockResolvedValue({ isFile: () => true, isDirectory: () => false })
            isBinaryFileStub.mockResolvedValue(false)
            extractTextStub.mockResolvedValue("console.log('Frontend');")

            const result = await resolveMention(
                file("/src/index.ts", "frontend"),
                environment({ fileContextTracker: fileContextTrackerStub, workspaceManager: workspaceManager() }),
            )

            expect(result).to.equal(`'frontend:src/index.ts' (see below for file content)

<file_content path="src/index.ts" workspace="frontend">
console.log('Frontend');
</file_content>`)
            const statted = fsStatStub.mock.calls.map((call: unknown[]) => String(call[0]))
            expect(statted).to.have.length(1)
            expect(statted[0]).to.include("frontend")
            expect(fileContextTrackerStub.trackFileContext.mock.calls).to.deep.equal([["src/index.ts", "file_mentioned"]])
        })

        it("reports a workspace prefix that names no root", async () => {
            const result = await resolveMention(file("/a.ts", "missing"), environment({ workspaceManager: workspaceManager() }))

            expect(result).to.contain(
                `<file_content path="a.ts" workspace="missing">\nError fetching content: Workspace 'missing' not found`,
            )
            expect(fsStatStub.mock.calls).to.have.length(0)
        })

        it("searches every root for an unprefixed file and attributes each match", async () => {
            fsStatStub.mockResolvedValue({ isFile: () => true, isDirectory: () => false })
            isBinaryFileStub.mockResolvedValue(false)
            extractTextStub.mockResolvedValueOnce('{"env": "dev"}').mockResolvedValue('{"env": "prod"}')

            const result = await resolveMention(
                file("/config.json"),
                environment({ fileContextTracker: fileContextTrackerStub, workspaceManager: workspaceManager() }),
            )

            expect(result).to.include('workspace="frontend"')
            expect(result).to.include('workspace="backend"')
            expect(result).to.include('{"env": "dev"}')
            expect(result).to.include('{"env": "prod"}')
            // An ambiguous match is not tracked as the file the user meant.
            expect(fileContextTrackerStub.trackFileContext.mock.calls).to.have.length(0)
        })
    })
})
