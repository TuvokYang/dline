import { afterEach, describe, expect, it, vi } from "vitest"
import { Logger } from "../Logger"

/**
 * Canary suite for WS-017 AC-004.
 *
 * These cases pin the privacy contract for Dline Output: the shapes below are
 * the ones real call sites hand to the Logger, and none of them may leak the
 * literal command, MCP argument, or task title text a user typed.
 */

/** Capture what the Logger would publish to its subscribers. */
function captureOutput(): { messages: string[]; restore: () => void } {
    const messages: string[] = []
    const spy = vi
        .spyOn(Logger as unknown as { output: (message: string) => void }, "output")
        .mockImplementation((message: string) => {
            messages.push(message)
        })
    return { messages, restore: () => spy.mockRestore() }
}

describe("Logger content privacy canaries", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("does not publish the literal MCP stdio command line", () => {
        const { messages } = captureOutput()

        Logger.error("[MCP local-secrets] spawn failed", {
            server: "local-secrets",
            command: "node",
            args: ["./scripts/mcp-server.js", "--token", "mcp-canary-token"],
        })

        const joined = messages.join("\n")
        expect(joined).not.toContain("mcp-canary-token")
        expect(joined).not.toContain("./scripts/mcp-server.js")
    })

    it("does not publish MCP tool argument values or result bodies", () => {
        const { messages } = captureOutput()

        Logger.error("[MCP local-secrets] tool call failed", {
            tool: "read_secret",
            arguments: { path: "/home/user/.aws/credentials", reveal: "mcp-argument-canary" },
            result: { content: [{ type: "text", text: "aws_secret_access_key=mcp-result-canary" }] },
        })

        const joined = messages.join("\n")
        expect(joined).not.toContain("mcp-argument-canary")
        expect(joined).not.toContain("mcp-result-canary")
        expect(joined).not.toContain("/home/user/.aws/credentials")
    })

    it("does not publish execute_command bodies or captured output", () => {
        const { messages } = captureOutput()

        Logger.error("[Terminal] command failed", {
            command: "curl -H 'X-Api-Key: command-canary-key' https://internal.example/deploy",
            stdout: "deploy log stdout-canary",
            stderr: "deploy log stderr-canary",
        })

        const joined = messages.join("\n")
        expect(joined).not.toContain("command-canary-key")
        expect(joined).not.toContain("stdout-canary")
        expect(joined).not.toContain("stderr-canary")
    })

    it("does not publish task title text", () => {
        const { messages } = captureOutput()

        Logger.info("[Controller] Panel title synced", {
            taskId: "task-1",
            title: "Rotate the production database password title-canary",
        })

        const joined = messages.join("\n")
        expect(joined).not.toContain("title-canary")
        expect(joined).not.toContain("Rotate the production database password")
    })

    it("keeps actionable error identity while dropping the sensitive body", () => {
        const { messages } = captureOutput()

        const error = Object.assign(new Error("Request failed with status code 401"), {
            code: "ERR_BAD_REQUEST",
            status: 401,
        })

        Logger.error("[Provider] request failed", error)

        const joined = messages.join("\n")
        expect(joined).toContain("ERR_BAD_REQUEST")
        expect(joined).toContain("401")
        expect(joined).not.toBe("")
    })
})
