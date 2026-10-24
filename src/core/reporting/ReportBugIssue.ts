import { createAndOpenGitHubIssue } from "@utils/github-url-utils"
import * as os from "os"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { redactDiagnosticString } from "@/shared/services/logging/safe-diagnostic-value"
import { shouldVisitLoopbackUrlDirectly } from "@/utils/e2e-loopback-visit"

const REPORT_OWNER = "TuvokYang"
const REPORT_REPOSITORY = "dline"
const REPORT_TEMPLATE = "bug_report.yml"
const REPORT_BUG_E2E_CAPTURE_PATH = "/.test/external-url"
const RECENT_ERROR_LIMIT = 4_000

export interface ReportBugContent {
    readonly title: string
    readonly whatHappened: string
    readonly stepsToReproduce: string
    readonly apiRequestOutput: string
    readonly additionalContext: string
}

export interface ReportBugEnvironment {
    readonly providerAndModel: string
    readonly operatingSystem: string
    readonly systemInfo: string
    readonly dlineVersion: string
}

/** Collect host facts shared by AI-authored and local fallback reports. */
export async function collectReportBugEnvironment(providerAndModel: string): Promise<ReportBugEnvironment> {
    const host = await HostProvider.env.getHostVersion({})
    return {
        providerAndModel,
        operatingSystem: `${os.platform()} ${os.release()}`,
        systemInfo: `${host.platform}: ${host.version}, Node.js: ${process.version}, Architecture: ${os.arch()}`,
        dlineVersion: ExtensionRegistryInfo.version,
    }
}

/** Add user-authored text without replacing the report the AI already prepared. */
export function appendReportBugSupplement(content: ReportBugContent, supplement: string | undefined): ReportBugContent {
    const text = supplement?.trim()
    if (!text) return content
    return {
        ...content,
        additionalContext: [content.additionalContext.trim(), `User supplement:\n${text}`].filter(Boolean).join("\n\n"),
    }
}

/** A bounded, credential-redacted error suitable for an editable issue draft. */
export function recentReportBugError(error: string | undefined): string | undefined {
    const redacted = error ? redactDiagnosticString(error).trim() : ""
    return redacted ? redacted.slice(0, RECENT_ERROR_LIMIT) : undefined
}

/** JSON rendered by the existing ReportBug preview. */
export function reportBugPresentation(content: ReportBugContent, environment: ReportBugEnvironment): string {
    return JSON.stringify({
        title: content.title,
        what_happened: content.whatHappened,
        steps_to_reproduce: content.stepsToReproduce,
        api_request_output: content.apiRequestOutput,
        additional_context: content.additionalContext,
        provider_and_model: environment.providerAndModel,
        operating_system: environment.operatingSystem,
        system_info: environment.systemInfo,
        cline_version: environment.dlineVersion,
    })
}

function reportBugE2ECaptureUrl(env: NodeJS.ProcessEnv): string | undefined {
    if (env.E2E_TEST !== "true") return undefined
    const mockBaseUrl = env.DLINE_E2E_API_BASE_URL?.trim()
    if (!mockBaseUrl) throw new Error("Report bug E2E capture requires DLINE_E2E_API_BASE_URL.")
    const captureUrl = new URL(REPORT_BUG_E2E_CAPTURE_PATH, mockBaseUrl).toString()
    if (!shouldVisitLoopbackUrlDirectly(captureUrl, env)) {
        throw new Error("Report bug E2E capture URL must be a plain-HTTP loopback URL.")
    }
    return captureUrl
}

/** Open the editable GitHub issue form; the browser owns final user confirmation and submission. */
export async function openReportBugIssue(
    content: ReportBugContent,
    environment: ReportBugEnvironment,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const params = new Map<string, string>()
    params.set("title", content.title)
    params.set("operating-system", environment.operatingSystem)
    params.set("cline-version", environment.dlineVersion)
    params.set("system-info", environment.systemInfo)
    params.set("additional-context", content.additionalContext)
    params.set("what-happened", content.whatHappened)
    params.set("steps", content.stepsToReproduce)
    params.set("provider-model", environment.providerAndModel)
    params.set("logs", content.apiRequestOutput)
    const captureUrl = reportBugE2ECaptureUrl(env)
    if (captureUrl) {
        await createAndOpenGitHubIssue(REPORT_OWNER, REPORT_REPOSITORY, REPORT_TEMPLATE, params, { baseUrl: captureUrl })
        return
    }
    await createAndOpenGitHubIssue(REPORT_OWNER, REPORT_REPOSITORY, REPORT_TEMPLATE, params)
}
