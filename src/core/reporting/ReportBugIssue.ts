import {
    createReportBugDraft,
    type ReportBugContent,
    type ReportBugEnvironment,
    serializeReportBugDraft,
} from "@shared/report-bug"
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
/**
 * Issue Form field that renders under `### Dline telemetry support code`
 * (telemetry-exchange-flow §5.1). The consent checkbox beside it cannot be
 * prefilled by URL, so the reporter ticks it in the form themselves.
 */
const SUPPORT_CODE_FIELD = "telemetry-support-code"

export type { ReportBugContent, ReportBugDraft, ReportBugEnvironment } from "@shared/report-bug"

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

/** A bounded, credential-redacted error suitable for an editable issue draft. */
export function recentReportBugError(error: string | undefined): string | undefined {
    const redacted = error ? redactDiagnosticString(error).trim() : ""
    return redacted ? redacted.slice(0, RECENT_ERROR_LIMIT) : undefined
}

/** Canonical safe payload rendered and edited by every ReportBug preview. */
export function reportBugPresentation(content: ReportBugContent, environment: ReportBugEnvironment): string {
    return serializeReportBugDraft(createReportBugDraft(content, environment))
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

export interface OpenReportBugIssueOptions {
    /** Public support code of a temporary telemetry authorization; never the authorization code. */
    readonly supportCode?: string
    readonly env?: NodeJS.ProcessEnv
}

/** Open the editable GitHub issue form; the browser owns final user confirmation and submission. */
export async function openReportBugIssue(
    content: ReportBugContent,
    environment: ReportBugEnvironment,
    options: OpenReportBugIssueOptions = {},
): Promise<void> {
    const env = options.env ?? process.env
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
    if (options.supportCode) params.set(SUPPORT_CODE_FIELD, options.supportCode)
    const captureUrl = reportBugE2ECaptureUrl(env)
    if (captureUrl) {
        await createAndOpenGitHubIssue(REPORT_OWNER, REPORT_REPOSITORY, REPORT_TEMPLATE, params, { baseUrl: captureUrl })
        return
    }
    await createAndOpenGitHubIssue(REPORT_OWNER, REPORT_REPOSITORY, REPORT_TEMPLATE, params)
}
