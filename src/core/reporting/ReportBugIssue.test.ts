import { beforeEach, describe, expect, it, vi } from "vitest"
import { openReportBugIssue, type ReportBugEnvironment, recentReportBugError } from "./ReportBugIssue"

type OpenIssueArgs = [string, string, string | null, Map<string, string>, { baseUrl?: string }?]

const github = vi.hoisted(() => ({
    open: vi.fn(async (..._args: OpenIssueArgs) => undefined),
}))

vi.mock("@utils/github-url-utils", () => ({ createAndOpenGitHubIssue: github.open }))

const content = {
    title: "Bug",
    whatHappened: "It failed",
    stepsToReproduce: "Run it",
    apiRequestOutput: "failure",
    additionalContext: "AI context",
}

const environment: ReportBugEnvironment = {
    providerAndModel: "openai / model-1",
    operatingSystem: "test-os",
    systemInfo: "test-system",
    dlineVersion: "test-version",
}

describe("ReportBugIssue", () => {
    beforeEach(() => vi.clearAllMocks())

    it("redacts and bounds a recent error before attaching it", () => {
        const safe = recentReportBugError(`token=ghp_1234567890123456 ${"x".repeat(5_000)}`)
        expect(safe).not.toContain("ghp_1234567890123456")
        expect(safe?.length).toBeLessThanOrEqual(4_000)
    })

    it("opens the editable GitHub issue form with the shared report fields", async () => {
        await openReportBugIssue(content, environment, { env: {} as NodeJS.ProcessEnv })

        expect(github.open).toHaveBeenCalledOnce()
        const [owner, repository, template, params] = github.open.mock.calls[0]
        expect({ owner, repository, template }).toEqual({
            owner: "TuvokYang",
            repository: "dline",
            template: "bug_report.yml",
        })
        expect(Object.fromEntries(params)).toEqual({
            title: "Bug",
            "operating-system": "test-os",
            "cline-version": "test-version",
            "system-info": "test-system",
            "additional-context": "AI context",
            "what-happened": "It failed",
            steps: "Run it",
            "provider-model": "openai / model-1",
            logs: "failure",
        })
        expect(github.open.mock.calls[0]).toHaveLength(4)
    })

    it("prefills only the public support code field of a temporary telemetry report", async () => {
        await openReportBugIssue(content, environment, {
            supportCode: "DLN-BNKP-5RJG-NE6R-Y290",
            env: {} as NodeJS.ProcessEnv,
        })

        const params = Object.fromEntries(github.open.mock.calls[0][3])
        expect(params["telemetry-support-code"]).toBe("DLN-BNKP-5RJG-NE6R-Y290")
        // The consent checkbox is the reporter's own act in the Issue Form; no field prefills it.
        expect(Object.keys(params).filter((key) => key.startsWith("telemetry-"))).toEqual(["telemetry-support-code"])
    })

    it("routes an E2E report to the loopback capture without changing its issue fields", async () => {
        await openReportBugIssue(content, environment, {
            env: { E2E_TEST: "true", DLINE_E2E_API_BASE_URL: "http://127.0.0.1:4173" } as NodeJS.ProcessEnv,
        })

        expect(github.open).toHaveBeenCalledOnce()
        const [owner, repository, template, params, options] = github.open.mock.calls[0]
        expect({ owner, repository, template, options }).toEqual({
            owner: "TuvokYang",
            repository: "dline",
            template: "bug_report.yml",
            options: { baseUrl: "http://127.0.0.1:4173/.test/external-url" },
        })
        expect(Object.fromEntries(params)).toEqual({
            title: "Bug",
            "operating-system": "test-os",
            "cline-version": "test-version",
            "system-info": "test-system",
            "additional-context": "AI context",
            "what-happened": "It failed",
            steps: "Run it",
            "provider-model": "openai / model-1",
            logs: "failure",
        })
    })

    it.each([
        ["missing base URL", { E2E_TEST: "true" }],
        ["remote base URL", { E2E_TEST: "true", DLINE_E2E_API_BASE_URL: "https://example.com" }],
    ])("fails closed for an E2E report with %s", async (_case, env) => {
        await expect(openReportBugIssue(content, environment, { env: env as NodeJS.ProcessEnv })).rejects.toThrow(/E2E capture/i)
        expect(github.open).not.toHaveBeenCalled()
    })
})
