import { StringRequest } from "@shared/proto/dline/common"
import { TriangleAlertIcon } from "lucide-react"
import type { ReactNode } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import { FileServiceClient } from "@/services/grpc-client"
import { ClineError } from "../../../../src/services/error/ClineError"

interface ApiErrorDetails {
    status?: number
    code?: string
    message: string
    providerId?: string
    modelId?: string
    requestId?: string
    additionalDetails: Array<{ key: string; label: string; value: string }>
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseSerializedError(value?: string): Record<string, unknown> | undefined {
    if (!value) return undefined
    try {
        const parsed: unknown = JSON.parse(value)
        return isRecord(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

function readableErrorValue(value: unknown): string | undefined {
    const direct = primitiveDisplayValue(value)
    if (direct !== undefined) return direct
    if (!isRecord(value)) return undefined

    const message = readString(value.message)
    if (message) return message
    const detail = readableErrorValue(value.detail)
    if (detail) return detail

    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

function displayLabel(key: string): string {
    return key
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll(/[_-]+/g, " ")
        .replace(/^./, (character) => character.toUpperCase())
}

function detailTestId(key: string): string {
    return key
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replaceAll(/[^a-zA-Z0-9]+/g, "-")
        .replaceAll(/^-|-$/g, "")
        .toLowerCase()
}

const SENSITIVE_DETAIL_KEY = /(?:authorization|api.?key|token|secret|password|cookie)/i
const MAX_ADDITIONAL_DETAILS = 16
const API_REQUEST_FAILED_TITLE = "API Request Failed"

function writeApiErrorToClipboard(text: string): Promise<unknown> {
    return FileServiceClient.copyToClipboard(StringRequest.create({ value: text }))
}

function primitiveDisplayValue(value: unknown): string | undefined {
    if (typeof value === "string") return readString(value)
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
    if (typeof value === "boolean") return String(value)
    if (Array.isArray(value)) {
        const items = value.map(primitiveDisplayValue)
        if (items.every((item): item is string => item !== undefined)) return items.join(", ")
    }
    return undefined
}

function collectAdditionalDetails(
    value: unknown,
    knownValues: ReadonlySet<string>,
    path: string[] = [],
    result: ApiErrorDetails["additionalDetails"] = [],
): ApiErrorDetails["additionalDetails"] {
    if (result.length >= MAX_ADDITIONAL_DETAILS) return result

    const displayValue = primitiveDisplayValue(value)
    if (displayValue !== undefined) {
        if (path.length === 0 || knownValues.has(displayValue)) return result
        const key = path.join("-")
        result.push({
            key: detailTestId(key),
            label: path.map(displayLabel).join(" / "),
            value: displayValue,
        })
        return result
    }

    if (!isRecord(value) || path.length >= 2) return result
    for (const [key, child] of Object.entries(value)) {
        if (result.length >= MAX_ADDITIONAL_DETAILS) break
        if (SENSITIVE_DETAIL_KEY.test(key)) continue
        collectAdditionalDetails(child, knownValues, [...path, key], result)
    }
    return result
}

/** Parse the serialized provider error into the fields users need to act on it. */
export function parseApiErrorDetails(serializedError?: string): ApiErrorDetails {
    const directRecord = parseSerializedError(serializedError)
    const parsed = ClineError.parse(serializedError)
    const details: unknown =
        parsed?._error?.details ??
        directRecord?.details ??
        directRecord?.error ??
        (directRecord?.detail !== undefined ? { detail: directRecord.detail } : undefined)
    const detailRecord = isRecord(details) ? details : undefined
    const status = parsed?._error?.status ?? readNumber(directRecord?.status) ?? readNumber(detailRecord?.status)
    const code = readString(parsed?._error?.code) ?? readString(directRecord?.code) ?? readString(detailRecord?.code)
    const providerId =
        readString(parsed?.providerId) ?? readString(parsed?._error?.providerId) ?? readString(directRecord?.providerId)
    const modelId = readString(parsed?.modelId) ?? readString(parsed?._error?.modelId) ?? readString(directRecord?.modelId)
    const requestId = readString(parsed?._error?.request_id) ?? readString(directRecord?.request_id)
    const message =
        readString(detailRecord?.message) ??
        readableErrorValue(directRecord?.detail) ??
        readString(directRecord?.message) ??
        readString(parsed?._error?.message) ??
        readString(parsed?.message) ??
        readableErrorValue(directRecord) ??
        serializedError ??
        "Unknown API error"
    const knownValues = new Set(
        [status, code, providerId, modelId, requestId, message].filter((value) => value !== undefined).map(String),
    )
    return {
        status,
        code,
        message,
        providerId,
        modelId,
        requestId,
        additionalDetails: collectAdditionalDetails(details ?? directRecord, knownValues),
    }
}

/** Render one structured API error with an optional status section below it. */
export function ApiErrorBox({
    error,
    children,
    testId = "api-error-box",
    title = API_REQUEST_FAILED_TITLE,
}: {
    error?: string
    children?: ReactNode
    testId?: string
    title?: string
}) {
    const details = parseApiErrorDetails(error)
    const metadata = [
        { label: "Provider", value: details.providerId, testId: `${testId}-provider` },
        { label: "Model", value: details.modelId, testId: `${testId}-model` },
        { label: "HTTP status", value: details.status, testId: `${testId}-status` },
        { label: "Error code", value: details.code, testId: `${testId}-code` },
        { label: "Request ID", value: details.requestId, testId: `${testId}-request-id` },
    ].filter((field) => field.value !== undefined)
    const copyText = [
        title,
        "",
        details.message,
        ...(metadata.length > 0 ? ["", ...metadata.map((field) => `${field.label}: ${field.value}`)] : []),
        ...(details.additionalDetails.length > 0
            ? ["", "Details", ...details.additionalDetails.map((field) => `${field.label}: ${field.value}`)]
            : []),
    ].join("\n")
    return (
        <div className="overflow-hidden rounded-sm border border-error/50 bg-error/10" data-testid={testId}>
            <div className="p-3">
                <div className="flex items-center justify-between gap-2 text-error">
                    <div className="flex min-w-0 items-center gap-2">
                        <TriangleAlertIcon className="size-3 shrink-0" />
                        <div className="font-medium text-xs">{title}</div>
                    </div>
                    {title === API_REQUEST_FAILED_TITLE && (
                        <CopyButton
                            ariaLabel="Copy error"
                            className="shrink-0 text-error"
                            textToCopy={copyText}
                            writeText={writeApiErrorToClipboard}
                        />
                    )}
                </div>
                <div className="mt-3 whitespace-pre-wrap break-words text-foreground text-xs" data-testid={`${testId}-message`}>
                    {details.message}
                </div>
                {metadata.length > 0 && (
                    <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 border-error/30 border-t pt-3 text-xs">
                        {metadata.map((field) => (
                            <div className="contents" key={field.label}>
                                <dt className="text-description">{field.label}</dt>
                                <dd className="m-0 break-all font-mono text-foreground" data-testid={field.testId}>
                                    {field.value}
                                </dd>
                            </div>
                        ))}
                    </dl>
                )}
                {details.additionalDetails.length > 0 && (
                    <div className="mt-3 border-error/30 border-t pt-3 text-xs" data-testid={`${testId}-details`}>
                        <div className="font-medium text-foreground">Details</div>
                        <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2">
                            {details.additionalDetails.map((field) => (
                                <div className="contents" key={`${field.key}:${field.label}`}>
                                    <dt className="text-description">{field.label}</dt>
                                    <dd
                                        className="m-0 whitespace-pre-wrap break-words text-foreground"
                                        data-testid={`${testId}-detail-${field.key}`}>
                                        {field.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                )}
            </div>
            {children && <div className="border-error/30 border-t bg-editor-background/30 px-3 py-2.5">{children}</div>}
        </div>
    )
}
