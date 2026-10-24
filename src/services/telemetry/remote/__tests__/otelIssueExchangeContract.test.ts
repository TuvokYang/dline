import { randomInt } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { DeviceTokenBroker } from "../auth/DeviceTokenBroker"
import { createRecoverableIssueExchangeRuntime } from "../auth/exchangeRuntime"
import { DlineOtelHttpClient } from "../transport/DlineOtelHttpClient"
import {
    installExternalIssueFixture,
    isOtelServiceMockAvailable,
    otelServiceMockEndpoint,
    readOtelServiceMockState,
} from "./support/OtelServiceMock"

const endpoint = otelServiceMockEndpoint()
const mockAvailable = await isOtelServiceMockAvailable(endpoint)
const PAIRING_SECRET = "s".repeat(43)
const PUBLIC_CODE = "DLN-BNKP-5RJG-NE6R-Y290"
const ISSUE = { owner: "TuvokYang", repo: "dline", number: randomInt(100_000, 1_000_000) } as const
const VERSION = "0.11.1"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("issue exchange service contract", () => {
    it.skipIf(!mockAvailable)("uses the current dline-web pairing-secret authority over real HTTP", async () => {
        await installExternalIssueFixture({ ...ISSUE, support_code: PUBLIC_CODE, state: "approved", revision: 1 }, endpoint)

        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-issue-contract-"))
        cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
        const layout = resolveOtelStorageLayout(root)
        const client = new DlineOtelHttpClient({ clientVersion: VERSION, endpoint })
        const devices = new DeviceCredentialRepository(layout)
        const broker = new DeviceTokenBroker({
            repository: devices,
            transport: client,
            clientVersion: VERSION,
            platform: process.platform,
        })
        const device = await broker.acquire("production")
        expect(device.status).toBe("ready")
        if (device.status !== "ready") throw new Error("Production device token was not issued")

        const issueRuntime = createRecoverableIssueExchangeRuntime({
            dataDir: root,
            clientVersion: VERSION,
            platform: process.platform,
            endpoint,
        })
        const exchanged = await issueRuntime.coordinator.exchange({
            deviceId: device.token.deviceId,
            deviceAccessToken: device.token.accessToken,
            issue: ISSUE,
            pairingSecret: PAIRING_SECRET,
            authorizationRevision: 1,
        })

        expect(exchanged).toMatchObject({
            status: "ready",
            grant: {
                profile: "issue_diagnostic",
                authorizationRevision: 1,
                rateLimits: { maxRequestBytes: 8 * 1024 * 1024, maxRequests: 120, maxRecords: 20_000 },
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

        await installExternalIssueFixture({ ...ISSUE, support_code: PUBLIC_CODE, state: "revoked", revision: 1 }, endpoint)
        const rejected = await client.sendIssueDiagnostics({
            stream: "logs",
            accessToken: exchanged.grant.accessToken,
            requestId: "99999999-9999-4999-8999-999999999999",
            body: new TextEncoder().encode(JSON.stringify({ resourceLogs: [] })),
        })
        expect(rejected).toMatchObject({ status: 401, json: { error: { code: "invalid_access_token" } } })
    })
})
