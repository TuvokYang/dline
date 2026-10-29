import { describe, expect, it } from "vitest"
import {
    describeCodeExecutionOperation,
    normalizeCodeExecutionErrorCode,
    normalizeCodeExecutionOutput,
    normalizeHostedCodeExecutionOperation,
} from "../code-execution-tools"

describe("normalizeHostedCodeExecutionOperation", () => {
    it("recovers submitted code, preserving the whitespace that makes it runnable", () => {
        const code = "def main():\n    print('hello')\n"

        expect(normalizeHostedCodeExecutionOperation({ code })).toEqual({ type: "code", code })
    })

    it("reads through an input envelope, since the payload arrives from two stream positions", () => {
        expect(normalizeHostedCodeExecutionOperation({ input: { command: "ls -la" } })).toEqual({
            type: "bash",
            command: "ls -la",
        })
    })

    it("distinguishes a file edit from a shell command by the presence of a path", () => {
        expect(normalizeHostedCodeExecutionOperation({ command: "create", path: "/tmp/report.py" })).toEqual({
            type: "text_editor",
            command: "create",
            path: "/tmp/report.py",
        })
    })

    it("defaults a path-only edit to a view, which is the non-destructive reading", () => {
        expect(normalizeHostedCodeExecutionOperation({ file_path: "/tmp/out.txt" })).toEqual({
            type: "text_editor",
            command: "view",
            path: "/tmp/out.txt",
        })
    })

    it("keeps an unrecognized facet visible instead of discarding it", () => {
        expect(normalizeHostedCodeExecutionOperation({ type: "future_sandbox_facet" })).toEqual({
            type: "unknown",
            providerType: "future_sandbox_facet",
        })
        expect(normalizeHostedCodeExecutionOperation(undefined)).toEqual({ type: "unknown" })
    })
})

describe("describeCodeExecutionOperation", () => {
    it("labels each facet and reports nothing for an undescribed call", () => {
        expect(describeCodeExecutionOperation({ type: "code", code: "print(1)" })).toBe("print(1)")
        expect(describeCodeExecutionOperation({ type: "bash", command: "pwd" })).toBe("pwd")
        expect(describeCodeExecutionOperation({ type: "text_editor", command: "view", path: "/a.txt" })).toBe("view /a.txt")
        expect(describeCodeExecutionOperation({ type: "unknown" })).toBeUndefined()
        expect(describeCodeExecutionOperation(undefined)).toBeUndefined()
    })
})

describe("normalizeCodeExecutionOutput", () => {
    it("captures both streams, the exit code, and produced files", () => {
        expect(
            normalizeCodeExecutionOutput({
                content: {
                    stdout: "hello\n",
                    stderr: "warning\n",
                    return_code: 0,
                    content: [{ file_id: "chart.png" }],
                },
            }),
        ).toEqual({
            stdout: "hello\n",
            stderr: "warning\n",
            returnCode: 0,
            files: ["chart.png"],
        })
    })

    it("retains a non-zero exit code even when nothing was printed", () => {
        expect(normalizeCodeExecutionOutput({ return_code: 1 })).toEqual({ returnCode: 1 })
    })

    it("reports nothing when the payload carries no execution evidence", () => {
        expect(normalizeCodeExecutionOutput({ unrelated: true })).toBeUndefined()
        expect(normalizeCodeExecutionOutput(undefined)).toBeUndefined()
    })
})

describe("normalizeCodeExecutionErrorCode", () => {
    it("surfaces the provider error code, which is the actionable part of a failure", () => {
        expect(normalizeCodeExecutionErrorCode({ content: { error_code: "too_many_requests" } })).toBe("too_many_requests")
        expect(normalizeCodeExecutionErrorCode({ error_code: "unavailable" })).toBe("unavailable")
    })

    it("reports nothing rather than inventing a code the provider did not send", () => {
        expect(normalizeCodeExecutionErrorCode({ message: "boom" })).toBeUndefined()
        expect(normalizeCodeExecutionErrorCode(undefined)).toBeUndefined()
    })
})
