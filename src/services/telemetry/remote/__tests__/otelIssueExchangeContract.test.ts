import { randomInt } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { createDeviceTokenBroker, createReportAuthorizationRuntime } from "../auth/exchangeRuntime"
import type { PublishedReportTicket } from "../auth/ReportAuthorizationCoordinator"
import { parseReportAuthorizationStatus } from "../contracts/reportAuthorization"
import { DlineOtelHttpClient } from "../transport/DlineOtelHttpClient"
import {
    installExternalIssueFixture,
    isOtelServiceMockAvailable,
    otelServiceMockEndpoint,
    readOtelServiceMockState,
} from "./support/OtelServiceMock"

const endpoint = otelServiceMockEndpoint()
const mockAvailable = await isOtelServiceMockAvailable(endpoint)
const ISSUE = { owner: "TuvokYang", repo: "dline", number: randomInt(100_000, 1_000_000) } as const
const VERSION = "0.11.1"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("issue exchange service contract", () => {
    it.skipIf(!mockAvailable)(
        "issues a ticket, links it by public code and exchanges the approved revision over real HTTP",
        async () => {
            const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-issue-contract-"))
            cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
            const layout = resolveOtelStorageLayout(root)
            const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint })
            const devices = new DeviceCredentialRepository(layout)
            const broker = createDeviceTokenBroker({
                layout,
                credentials: devices,
                transport: client,
                clientVersion: VERSION,
                platform: process.platform,
            })
            const device = await broker.acquire("production")
            expect(device.status).toBe("ready")
            if (device.status !== "ready") throw new Error("Production device token was not issued")

            const tickets: PublishedReportTicket[] = []
            const runtime = createReportAuthorizationRuntime({
                layout,
                transport: client,
                tickets: { publish: async (ticket) => void tickets.push(ticket) },
                clientVersion: VERSION,
                platform: process.platform,
            })
            const credentials = { deviceId: device.token.deviceId, deviceAccessToken: device.token.accessToken }
            const issued = await runtime.authorizations.authorize(credentials)
            expect(issued).toMatchObject({ status: "issued", ticket: { state: "awaiting_issue" } })
            if (issued.status !== "issued") throw new Error("Report authorization was not issued")

            // The webhook links the Issue that carries the public code; the client never learns which one.
            await installExternalIssueFixture(
                { ...ISSUE, support_code: issued.ticket.publicCode, state: "approved", revision: 1 },
                endpoint,
            )
            const status = await client.queryReportAuthorization(issued.ticket.authorizationCode, device.token.accessToken)
            expect(parseReportAuthorizationStatus(status.json)).toMatchObject({ state: "approved", revision: 1 })

            const exchanged = await runtime.exchange.exchange({
                ...credentials,
                authorizationCode: issued.ticket.authorizationCode,
                authorizationRevision: 1,
            })

            expect(exchanged).toMatchObject({
                status: "ready",
                grant: {
                    profile: "issue_diagnostic",
                    authorizationRevision: 1,
                    rateLimits: { maxBytes: 8 * 1024 * 1024, maxRequests: 120, maxRecords: 20_000 },
                },
            })
            if (exchanged.status !== "ready") throw new Error("Issue token was not issued")

            const diagnostic = await client.sendIssueDiagnostics({
                stream: "logs",
                accessToken: exchanged.grant.accessToken,
                requestId: "88888888-8888-4888-8888-888888888888",
                body: new TextEncoder().encode(JSON.stringify({ resourceLogs: [] })),
            })
            expect(diagnostic).toMatchObject({ status: 200, json: { disposition: "accepted", duplicate: false } })

            const state = await readOtelServiceMockState(endpoint)
            expect(state.claims).toEqual(
                expect.arrayContaining([expect.objectContaining({ issue: ISSUE, state: "approved", authorization_revision: 1 })]),
            )
            expect(state.accepted).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ path: "/v1/logs", request_id: "88888888-8888-4888-8888-888888888888" }),
                ]),
            )

            await installExternalIssueFixture(
                { ...ISSUE, support_code: issued.ticket.publicCode, state: "revoked", revision: 1 },
                endpoint,
            )
            const rejected = await client.sendIssueDiagnostics({
                stream: "logs",
                accessToken: exchanged.grant.accessToken,
                requestId: "99999999-9999-4999-8999-999999999999",
                body: new TextEncoder().encode(JSON.stringify({ resourceLogs: [] })),
            })
            expect(rejected).toMatchObject({ status: 401, json: { error: { code: "invalid_access_token" } } })
        },
    )
})
