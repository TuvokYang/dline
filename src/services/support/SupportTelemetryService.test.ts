import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mockFetchForTesting } from "@shared/net"
import { createReportBugDraft } from "@shared/report-bug"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { SupportAuthorizationError, SupportTelemetryService } from "./SupportTelemetryService"

const issue = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => undefined) }))
vi.mock("@core/reporting/ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")
    return { ...actual, openReportBugIssue: issue.open }
})

const FIXTURES = path.join(__dirname, "..", "telemetry", "remote", "contracts", "__tests__", "fixtures")
const USAGE_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURES, "usage-schema4-reference.json"), "utf8"))
const NOW = 1_900_000_000_000
const DEVICE_ID = "dev_0123456789abcdef0123456789abcdef"
const DEVICE_TOKEN = "t".repeat(43)
const AUTHORIZATION_CODE = "s".repeat(43)
// The fixture vector of telemetry-exchange-flow §5.1 for this authorization code.
const PUBLIC_CODE = "DLN-BNKP-5RJG-NE6R-Y290"

const draft = (consent = true) =>
    createReportBugDraft(
        {
            title: "Provider failed",
            whatHappened: "The request failed.",
            stepsToReproduce: "Send the request.",
            apiRequestOutput: "safe output",
            additionalContext: "context",
        },
        { providerAndModel: "test / model", operatingSystem: "test", systemInfo: "test", dlineVersion: "1.2.3" },
        consent,
    )

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function status(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ok: true,
        state: "approved",
        authorization_revision: 1,
        authorization_expires_at: NOW + 86_400_000,
        capture_expires_at: NOW + 60_000,
        ticket_expires_at: NOW + 90 * 86_400_000,
        issue_state: "open",
        resolution: { state: "investigating" },
        poll_after_ms: 300_000,
        ...fields,
    }
}

interface Call {
    readonly path: string
    readonly body: Record<string, unknown>
    readonly headers: Headers
}

/** In-memory OTel answering the four routes the client uses; each route's answer is replaceable per test. */
class FakeOtel {
    readonly calls: Call[] = []
    authorize: (body: Record<string, unknown>) => Response | Promise<Response> = (body) =>
        json(200, {
            ok: true,
            request_id: body.request_id,
            authorization_code: AUTHORIZATION_CODE,
            state: "awaiting_issue",
            authorization_expires_at: NOW + 86_400_000,
            ticket_expires_at: NOW + 90 * 86_400_000,
            poll_after_ms: 60_000,
        })
    status: () => Response = () =>
        json(200, status({ state: "awaiting_issue", authorization_revision: 0, capture_expires_at: undefined }))
    exchange: (body: Record<string, unknown>) => Response = (body) =>
        json(200, {
            ok: true,
            request_id: body.request_id,
            access_token: "i".repeat(43),
            profile: "issue_diagnostic",
            scopes: ["error", "runtime", "debug", "high_density_metrics", "high_density_traces"],
            authorization_id: "grant-1",
            authorization_revision: body.authorization_revision,
            expires_at: NOW + 60_000,
            capture_expires_at: NOW + 60_000,
            rate_limits: { authorization_requests: 120, authorization_bytes: 8_388_608, authorization_records: 20_000 },
        })

    readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input))
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        this.calls.push({ path: url.pathname, body, headers: new Headers(init?.headers) })
        if (url.pathname === "/auth/device/grant") {
            return json(200, {
                ok: true,
                request_id: body.request_id,
                access_token: DEVICE_TOKEN,
                device_id: DEVICE_ID,
                profile: body.requested_profile,
                scopes: [body.requested_profile],
                expires_at: NOW + 3_600_000,
                usage_contract: USAGE_FIXTURE.device_grant.response.usage_contract,
            })
        }
        if (url.pathname === "/auth/report-authorizations") return this.authorize(body)
        if (url.pathname === "/auth/report-authorizations/status") return this.status()
        if (url.pathname === "/auth/exchange") return this.exchange(body)
        return json(404, {})
    }

    paths(): string[] {
        return this.calls.map((call) => call.path)
    }
}

describe("SupportTelemetryService", () => {
    let root: string
    let otel: FakeOtel
    const services: SupportTelemetryService[] = []

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-service-"))
        otel = new FakeOtel()
        issue.open.mockReset().mockResolvedValue(undefined)
    })

    afterEach(async () => {
        for (const service of services.splice(0)) service.dispose()
        await fs.rm(root, { recursive: true, force: true })
    })

    function service(): SupportTelemetryService {
        const created = new SupportTelemetryService({
            dataDir: path.join(root, "data"),
            clientVersion: "1.2.3",
            platform: "test",
            otelEndpoint: "http://127.0.0.1:8787",
            clock: () => NOW,
        })
        services.push(created)
        return created
    }

    const layout = () => resolveOtelStorageLayout(path.join(root, "data"))
    const run = <T>(operation: () => Promise<T>) => mockFetchForTesting(otel.fetch, operation)

    it("issues the ticket before opening the Issue with only the derived public code", async () => {
        const support = service()
        const projected = await run(() => support.createAuthorizationAndOpenIssue(draft()))

        expect(otel.paths()).toEqual(["/auth/device/grant", "/auth/report-authorizations"])
        const issuance = otel.calls[1]
        expect(issuance.headers.get("authorization")).toBe(`Bearer ${DEVICE_TOKEN}`)
        expect(issuance.headers.get("x-dline-request-id")).toBe(issuance.body.request_id)
        expect(issuance.body).toEqual({
            operation: "report.authorize",
            request_id: issuance.body.request_id,
            temporary_telemetry_consent: true,
            client_version: "1.2.3",
            platform: "test",
        })
        expect(issue.open).toHaveBeenCalledOnce()
        expect(issue.open.mock.calls[0][2]).toEqual({ supportCode: PUBLIC_CODE })
        expect(projected).toEqual({
            publicCode: PUBLIC_CODE,
            state: "awaiting_issue",
            authorizationExpiresAt: NOW + 86_400_000,
            issueState: "unlinked",
            resolution: { state: "none" },
        })
        expect(JSON.stringify(projected)).not.toContain(AUTHORIZATION_CODE)
    })

    it("opens no Issue when OTel refuses to issue a ticket", async () => {
        otel.authorize = () => json(429, { ok: false, error: { code: "report_authorization_rate_limited" } })
        const support = service()

        await expect(run(() => support.createAuthorizationAndOpenIssue(draft()))).rejects.toMatchObject({
            code: "report_authorization_rate_limited",
        })
        expect(issue.open).not.toHaveBeenCalled()
        await expect(support.status()).resolves.toBeUndefined()
    })

    it("replays the same issuance identity after the response was lost", async () => {
        otel.authorize = () => Promise.reject(new Error("connection reset"))
        const support = service()
        await expect(run(() => support.createAuthorizationAndOpenIssue(draft()))).rejects.toBeInstanceOf(
            SupportAuthorizationError,
        )
        const lost = otel.calls.find((call) => call.path === "/auth/report-authorizations")

        otel.authorize = new FakeOtel().authorize
        await run(() => support.createAuthorizationAndOpenIssue(draft()))

        const issuances = otel.calls.filter((call) => call.path === "/auth/report-authorizations")
        expect(issuances).toHaveLength(2)
        expect(issuances[1].body.request_id).toBe(lost?.body.request_id)
        expect(issue.open).toHaveBeenCalledOnce()
    })

    it("exchanges the approved revision once and keeps the ticket", async () => {
        const support = service()
        await run(() => support.createAuthorizationAndOpenIssue(draft()))
        otel.status = () => json(200, status())

        const approved = await run(() => support.checkNow())
        await run(() => support.checkNow())

        const exchanges = otel.calls.filter((call) => call.path === "/auth/exchange")
        expect(exchanges).toHaveLength(1)
        expect(exchanges[0].body).toMatchObject({ authorization_code: AUTHORIZATION_CODE, authorization_revision: 1 })
        expect(approved).toMatchObject({ state: "approved", issueState: "open", captureExpiresAt: NOW + 60_000 })
        await expect(new IssueGrantRepository(layout(), { clock: () => NOW }).readActive(NOW, 1)).resolves.not.toBeNull()
    })

    it("seals capture on a revoked status but keeps the ticket for its resolution", async () => {
        const support = service()
        await run(() => support.createAuthorizationAndOpenIssue(draft()))
        otel.status = () => json(200, status())
        await run(() => support.checkNow())
        otel.status = () =>
            json(
                200,
                status({
                    state: "revoked",
                    authorization_revision: 2,
                    capture_expires_at: undefined,
                    issue_state: "closed",
                    resolution: { state: "fixed", fixed_in_version: "0.12.1" },
                }),
            )

        await run(() => support.checkNow())

        await expect(new IssueGrantRepository(layout(), { clock: () => NOW }).readActive(NOW, 1)).resolves.toBeNull()
        await expect(support.status()).resolves.toMatchObject({
            state: "revoked",
            issueState: "closed",
            resolution: { state: "fixed", fixedInVersion: "0.12.1" },
        })
    })

    it("deletes the ticket locally when OTel no longer knows the authorization code", async () => {
        const support = service()
        await run(() => support.createAuthorizationAndOpenIssue(draft()))
        otel.status = () => json(404, { ok: false, error: { code: "report_authorization_not_found" } })

        await expect(run(() => support.checkNow())).resolves.toBeUndefined()
        await expect(fs.access(layout().issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("keeps the ticket on a 404 that does not carry the contract code", async () => {
        const support = service()
        await run(() => support.createAuthorizationAndOpenIssue(draft()))
        otel.status = () => json(404, {})

        await expect(run(() => support.checkNow())).rejects.toThrow("unavailable")
        await expect(support.status()).resolves.toMatchObject({ publicCode: PUBLIC_CODE })
    })

    it("never projects an Issue identity even when the response carries one", async () => {
        const support = service()
        await run(() => support.createAuthorizationAndOpenIssue(draft()))
        otel.status = () => json(200, status({ issue: { owner: "TuvokYang", repo: "dline", number: 123 }, issue_url: "x" }))

        const projected = await run(() => support.checkNow())

        expect(Object.keys(projected ?? {}).sort()).toEqual(
            ["authorizationExpiresAt", "captureExpiresAt", "issueState", "publicCode", "resolution", "state"].sort(),
        )
    })

    it("deletes and revokes locally without any request leaving the machine", async () => {
        const support = service()
        await run(() => support.createAuthorizationAndOpenIssue(draft()))
        otel.status = () => json(200, status())
        await run(() => support.checkNow())
        const before = otel.calls.length

        await run(() => support.deleteAndRevoke())

        expect(otel.calls).toHaveLength(before)
        await expect(support.status()).resolves.toBeUndefined()
        await expect(new IssueGrantRepository(layout(), { clock: () => NOW }).readActive(NOW, 1)).resolves.toBeNull()
    })

    it("refuses a draft without temporary telemetry consent before any request", async () => {
        const support = service()

        await expect(run(() => support.createAuthorizationAndOpenIssue(draft(false)))).rejects.toThrow("not consented")
        expect(otel.calls).toEqual([])
        expect(issue.open).not.toHaveBeenCalled()
    })
})
