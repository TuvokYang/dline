export const REPORT_BUG_DRAFT_SCHEMA_VERSION = 1 as const
export const REPORT_BUG_DRAFT_SELECTION_PREFIX = "report_bug_draft:"

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

/** Safe, user-editable report state. Private support credentials never belong here. */
export interface ReportBugDraft {
    readonly schemaVersion: typeof REPORT_BUG_DRAFT_SCHEMA_VERSION
    readonly content: ReportBugContent
    readonly environment: ReportBugEnvironment
    readonly temporaryTelemetryConsent: boolean
}

function stringField(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

function parseCanonical(value: Record<string, unknown>): ReportBugDraft | undefined {
    if (value.schemaVersion !== REPORT_BUG_DRAFT_SCHEMA_VERSION) return undefined
    const content = value.content
    const environment = value.environment
    if (!content || typeof content !== "object" || Array.isArray(content)) return undefined
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) return undefined
    const parsedContent = content as Record<string, unknown>
    const parsedEnvironment = environment as Record<string, unknown>
    const draft: ReportBugDraft = {
        schemaVersion: REPORT_BUG_DRAFT_SCHEMA_VERSION,
        content: {
            title: stringField(parsedContent.title) ?? "",
            whatHappened: stringField(parsedContent.whatHappened) ?? "",
            stepsToReproduce: stringField(parsedContent.stepsToReproduce) ?? "",
            apiRequestOutput: stringField(parsedContent.apiRequestOutput) ?? "",
            additionalContext: stringField(parsedContent.additionalContext) ?? "",
        },
        environment: {
            providerAndModel: stringField(parsedEnvironment.providerAndModel) ?? "",
            operatingSystem: stringField(parsedEnvironment.operatingSystem) ?? "",
            systemInfo: stringField(parsedEnvironment.systemInfo) ?? "",
            dlineVersion: stringField(parsedEnvironment.dlineVersion) ?? "",
        },
        temporaryTelemetryConsent: value.temporaryTelemetryConsent === true,
    }
    return draft
}

/** Read current drafts and the legacy snake_case presentation used by older tasks. */
export function parseReportBugDraft(value: unknown): ReportBugDraft | undefined {
    let parsed: unknown = value
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value)
        } catch {
            return undefined
        }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const canonical = parseCanonical(record)
    if (canonical) return canonical

    const legacyFields = [
        "title",
        "what_happened",
        "steps_to_reproduce",
        "api_request_output",
        "additional_context",
        "provider_and_model",
        "operating_system",
        "system_info",
        "cline_version",
    ]
    if (!legacyFields.some((field) => typeof record[field] === "string")) return undefined
    return {
        schemaVersion: REPORT_BUG_DRAFT_SCHEMA_VERSION,
        content: {
            title: stringField(record.title) ?? "",
            whatHappened: stringField(record.what_happened) ?? "",
            stepsToReproduce: stringField(record.steps_to_reproduce) ?? "",
            apiRequestOutput: stringField(record.api_request_output) ?? "",
            additionalContext: stringField(record.additional_context) ?? "",
        },
        environment: {
            providerAndModel: stringField(record.provider_and_model) ?? "",
            operatingSystem: stringField(record.operating_system) ?? "",
            systemInfo: stringField(record.system_info) ?? "",
            dlineVersion: stringField(record.cline_version) ?? "",
        },
        temporaryTelemetryConsent: false,
    }
}

export function createReportBugDraft(
    content: ReportBugContent,
    environment: ReportBugEnvironment,
    temporaryTelemetryConsent = false,
): ReportBugDraft {
    return {
        schemaVersion: REPORT_BUG_DRAFT_SCHEMA_VERSION,
        content: { ...content },
        environment: { ...environment },
        temporaryTelemetryConsent,
    }
}

export function serializeReportBugDraft(draft: ReportBugDraft): string {
    return JSON.stringify(draft)
}

export function reportBugDraftSelection(draft: ReportBugDraft): string[] {
    return [`${REPORT_BUG_DRAFT_SELECTION_PREFIX}${serializeReportBugDraft(draft)}`]
}

export function reportBugDraftFromSelection(values: readonly string[] | undefined): ReportBugDraft | undefined {
    const encoded = values?.find((value) => value.startsWith(REPORT_BUG_DRAFT_SELECTION_PREFIX))
    return encoded ? parseReportBugDraft(encoded.slice(REPORT_BUG_DRAFT_SELECTION_PREFIX.length)) : undefined
}
