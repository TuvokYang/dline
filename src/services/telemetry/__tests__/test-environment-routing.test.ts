import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let root: string

beforeEach(async () => {
    vi.resetModules()
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-routing-"))
})

afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
})

async function routeSupport(env: Readonly<Record<string, string | undefined>>, explicitEndpoint?: string) {
    for (const name of ["E2E_TEST", "IS_TEST", "DLINE_OTEL_ENDPOINT"]) vi.stubEnv(name, env[name] ?? "")
    const { configureSupportTelemetryService, SupportAuthorizationError } = await import(
        "@/services/support/SupportTelemetryService"
    )
    const { mockFetchForTesting } = await import("@/shared/net")
    const origins: string[] = []
    return mockFetchForTesting(
        async (input) => {
            origins.push(new URL(String(input)).origin)
            // Refuse at the first request so no token or support authorization is ever issued.
            return new Response(JSON.stringify({ ok: false, error: { code: "device_revoked" } }), {
                status: 403,
                headers: { "content-type": "application/json" },
            })
        },
        async () => {
            const support = configureSupportTelemetryService({
                dataDir: path.join(root, "data"),
                clientVersion: "0.14.1",
                platform: "test",
                otelEndpoint: explicitEndpoint,
            })
            if (!support) return { configured: false, origins }
            try {
                await expect(support.issueAuthorization()).rejects.toBeInstanceOf(SupportAuthorizationError)
            } finally {
                support.dispose()
            }
            return { configured: true, origins }
        },
    )
}

describe("support telemetry configuration routing", () => {
    it.each([
        { E2E_TEST: "true" },
        { E2E_TEST: "1" },
        { IS_TEST: "true" },
        { IS_TEST: "1" },
    ])("does not construct a remote support owner for %j", async (env) => {
        expect(await routeSupport(env)).toEqual({ configured: false, origins: [] })
    })

    it.each([
        "https://otel.dline.cc",
        "https://127.0.0.1.example.test",
        "http://user:secret@localhost:43190",
        "invalid",
    ])("does not fall back to production when a test override is rejected: %s", async (endpoint) => {
        expect(await routeSupport({ E2E_TEST: "true", DLINE_OTEL_ENDPOINT: endpoint })).toEqual({
            configured: false,
            origins: [],
        })
    })

    it.each([
        "http://127.0.0.1:43190",
        "http://localhost:43190",
        "http://[::1]:43190",
    ])("keeps an explicit test mock at its loopback origin: %s", async (endpoint) => {
        expect(await routeSupport({ E2E_TEST: "true", DLINE_OTEL_ENDPOINT: endpoint })).toEqual({
            configured: true,
            origins: [endpoint],
        })
    })

    it("preserves the production default", async () => {
        expect(await routeSupport({ E2E_TEST: "false", IS_TEST: "0" })).toEqual({
            configured: true,
            origins: ["https://otel.dline.cc"],
        })
    })

    it("preserves an explicitly configured loopback endpoint", async () => {
        expect(await routeSupport({ E2E_TEST: "true" }, "http://localhost:43190")).toEqual({
            configured: true,
            origins: ["http://localhost:43190"],
        })
    })
})
