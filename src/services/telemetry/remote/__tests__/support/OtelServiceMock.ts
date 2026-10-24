const DEFAULT_MOCK_ENDPOINT = "http://127.0.0.1:43190"
const PROBE_TIMEOUT_MS = 750

export interface ExternalOtelMockAccepted {
    readonly path: string
    readonly request_id: string
    readonly device_id: string
    readonly body: unknown
}

export interface ExternalOtelMockState {
    readonly ok: true
    readonly claims: ReadonlyArray<{
        readonly issue: { readonly owner: string; readonly repo: string; readonly number: number }
        readonly state: string
        readonly authorization_id: string
        readonly authorization_revision: number
    }>
    readonly accepted: readonly ExternalOtelMockAccepted[]
}

export interface ExternalIssueFixture {
    readonly owner: string
    readonly repo: string
    readonly number: number
    readonly support_code: string
    readonly state: "pending_approval" | "approved" | "revoked" | "closed"
    readonly revision?: number
}

/** URL-only adapter for the mock owned and implemented by dline-web. */
export function otelServiceMockEndpoint(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.DLINE_OTEL_MOCK_ENDPOINT?.trim()
    return configured || DEFAULT_MOCK_ENDPOINT
}

/** Probe the independent dline-web process. A closed port is a test skip, not a local fallback. */
export async function isOtelServiceMockAvailable(endpoint = otelServiceMockEndpoint()): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
        const response = await fetch(new URL("/healthz", endpoint), { signal: controller.signal })
        if (!response.ok) return false
        const body = (await response.json()) as Record<string, unknown>
        return body.service === "dline-otel-contract-mock" && body.contract_version === 4
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

export async function resetOtelServiceMock(endpoint = otelServiceMockEndpoint()): Promise<void> {
    await post(endpoint, "/__mock/reset", {})
}

export async function installExternalIssueFixture(
    fixture: ExternalIssueFixture,
    endpoint = otelServiceMockEndpoint(),
): Promise<void> {
    await post(endpoint, "/__mock/issues", fixture)
}

export async function readOtelServiceMockState(endpoint = otelServiceMockEndpoint()): Promise<ExternalOtelMockState> {
    const response = await fetch(new URL("/__mock/state", endpoint))
    if (!response.ok) throw new Error(`dline-web telemetry mock state failed with ${response.status}`)
    return (await response.json()) as ExternalOtelMockState
}

async function post(endpoint: string, pathname: string, body: object): Promise<void> {
    const response = await fetch(new URL(pathname, endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`dline-web telemetry mock ${pathname} failed with ${response.status}`)
}
