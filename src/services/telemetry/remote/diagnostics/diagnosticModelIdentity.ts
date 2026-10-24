import type { UsageServedModel } from "@/core/task/telemetry/UsageSettlement"
import { UNKNOWN_USAGE_ID } from "../contracts/usageIdentity"

const MAX_PROVIDER_LENGTH = 32
const MAX_MODEL_LENGTH = 64

/** Provider and model vocabulary used by diagnostics attributes. */
export interface DiagnosticModelIdentity {
    readonly provider: string
    readonly model: string
    readonly custom?: boolean
}

export function diagnosticModelIdentity(servedBy: UsageServedModel): DiagnosticModelIdentity {
    const provider = diagnosticProviderId(servedBy.provider)
    return {
        provider,
        model: normalizeId(servedBy.model, /[^a-z0-9_.-]+/g, MAX_MODEL_LENGTH),
        ...(servedBy.custom ? { custom: true } : {}),
    }
}

export function diagnosticProviderId(provider: string): string {
    return normalizeId(provider, /[^a-z0-9_-]+/g, MAX_PROVIDER_LENGTH)
}

function normalizeId(value: string, disallowed: RegExp, maxLength: number): string {
    const id = value.trim().toLowerCase().replace(disallowed, "_").slice(0, maxLength)
    return id.length > 0 ? id : UNKNOWN_USAGE_ID
}
