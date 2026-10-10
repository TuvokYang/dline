import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ProtoJsonMessage } from "@shared/ExtensionMessage"
import type { GrpcRequest } from "@shared/WebviewMessage"

interface DelayUnaryFault {
    action: "delay" | "delayRequest"
    service: string
    method: string
    occurrence: number
    delayMs: number
    markerName?: string
}

interface EmptyFetchMessageFault {
    action: "emptyFetchMessage" | "delayEmptyFetchMessage"
    service: string
    method: string
    occurrence: number
    delayMs?: number
    markerName?: string
}

type UnaryFault = DelayUnaryFault | EmptyFetchMessageFault

const requestCounts = new Map<string, number>()
let cachedPlanSource: string | undefined
let cachedPlans: UnaryFault[] = []

function faultsEnabled(): boolean {
    return process.env.E2E_TEST === "true" && Boolean(process.env.DLINE_E2E_GRPC_UNARY_FAULTS)
}

function parsePlans(): UnaryFault[] {
    const source = process.env.DLINE_E2E_GRPC_UNARY_FAULTS
    if (source === cachedPlanSource) return cachedPlans

    cachedPlanSource = source
    requestCounts.clear()
    if (!source || process.env.E2E_TEST !== "true") {
        cachedPlans = []
        return cachedPlans
    }

    const parsed = JSON.parse(source) as unknown
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    cachedPlans = candidates.filter(isUnaryFault)
    return cachedPlans
}

function isUnaryFault(value: unknown): value is UnaryFault {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<UnaryFault>
    if (typeof candidate.service !== "string" || typeof candidate.method !== "string") return false
    if (!Number.isInteger(candidate.occurrence) || Number(candidate.occurrence) < 1) return false
    if (candidate.action === "emptyFetchMessage") return true
    if (candidate.action === "delayEmptyFetchMessage") {
        return Number.isFinite(candidate.delayMs) && Number(candidate.delayMs) >= 0
    }
    return (
        (candidate.action === "delay" || candidate.action === "delayRequest") &&
        Number.isFinite(candidate.delayMs) &&
        Number(candidate.delayMs) >= 0
    )
}

async function writeMarker(markerName: string | undefined, state: "started" | "released"): Promise<void> {
    if (!markerName || !/^[A-Za-z0-9._-]+$/.test(markerName)) return
    const dlineDir = process.env.DLINE_DIR
    if (!dlineDir) return
    const markerDirectory = path.join(dlineDir, "e2e-markers")
    await mkdir(markerDirectory, { recursive: true })
    await writeFile(path.join(markerDirectory, markerName), state, "utf8")
}

function requestOccurrence(request: GrpcRequest): number {
    const requestKey = `${request.service}.${request.method}`
    const occurrence = (requestCounts.get(requestKey) ?? 0) + 1
    requestCounts.set(requestKey, occurrence)
    return occurrence
}

function matchingPlan(request: GrpcRequest, occurrence: number): UnaryFault | undefined {
    return parsePlans().find(
        (candidate) =>
            candidate.service === request.service && candidate.method === request.method && candidate.occurrence === occurrence,
    )
}

async function applyDelay(plan: DelayUnaryFault): Promise<void> {
    await writeMarker(plan.markerName, "started")
    await new Promise<void>((resolve) => setTimeout(resolve, plan.delayMs))
    await writeMarker(plan.markerName, "released")
}

/** Delay one configured unary handler before it mutates state. */
export async function applyE2EUnaryRequestFault(request: GrpcRequest): Promise<number> {
    if (!faultsEnabled()) return 0
    parsePlans()
    const occurrence = requestOccurrence(request)
    const plan = matchingPlan(request, occurrence)
    if (plan?.action === "delayRequest") await applyDelay(plan)
    return occurrence
}

/** Apply deterministic unary-response faults only inside explicitly configured E2E runs. */
export async function applyE2EUnaryResponseFault(
    request: GrpcRequest,
    occurrence: number,
    response: ProtoJsonMessage,
): Promise<ProtoJsonMessage> {
    if (!faultsEnabled()) return response
    const plan = matchingPlan(request, occurrence)
    if (!plan || plan.action === "delayRequest") return response

    if (plan.action === "emptyFetchMessage" || plan.action === "delayEmptyFetchMessage") {
        if (plan.action === "delayEmptyFetchMessage") {
            await applyDelay({ ...plan, action: "delay", delayMs: plan.delayMs ?? 0 })
        } else {
            await writeMarker(plan.markerName, "released")
        }
        return { ...response, messages: [] }
    }

    if (plan.action === "delay") await applyDelay(plan)
    return response
}
