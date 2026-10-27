import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseAtomicDeviceGrant, serializeAtomicDeviceGrant, USAGE_GRANT_HARD_LIMITS } from "../deviceGrant"

const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "usage-schema4-reference.json"), "utf8"))
/** The fixture token is a placeholder; the client accepts only the 43-character base64url credential the service issues. */
const ACCESS_TOKEN = "a".repeat(43)

function fixtureGrant(): Record<string, unknown> {
    return { ...FIXTURE.device_grant.response, access_token: ACCESS_TOKEN }
}

function withContract(fields: Record<string, unknown>): Record<string, unknown> {
    const grant = fixtureGrant()
    return { ...grant, usage_contract: { ...(grant.usage_contract as Record<string, unknown>), ...fields } }
}

function withoutContractField(field: string): Record<string, unknown> {
    const grant = fixtureGrant()
    const { [field]: _removed, ...contract } = grant.usage_contract as Record<string, unknown>
    return { ...grant, usage_contract: contract }
}

describe("device grant contract (telemetry-exchange-flow §4)", () => {
    it("reads the fixture grant, including the replay age and both echoed partition constants", () => {
        const grant = parseAtomicDeviceGrant(fixtureGrant())

        expect(grant).toMatchObject({
            accessToken: ACCESS_TOKEN,
            deviceId: "dev_0123456789abcdef0123456789abcdef",
            profile: "usage",
            scopes: ["usage"],
            usageContract: {
                schemaVersion: 5,
                contractVersion: 1,
                maxWriteRows: 256,
                eventWindowMs: 600_000,
                durationBucketThresholdMs: 60_000,
                maxRequestReplayAgeMs: 604_800_000,
            },
        })
        // Persisting and reading back yields the same capability, so no field is dropped on the way to disk.
        expect(grant && parseAtomicDeviceGrant(serializeAtomicDeviceGrant(grant))).toEqual(grant)
    })

    it("accepts a later revision of schema 5, which only adds compatible extensions", () => {
        expect(parseAtomicDeviceGrant(withContract({ contract_version: 2 }))?.usageContract.contractVersion).toBe(2)
    })

    it.each([
        ["the retired schema 4", withContract({ schema_version: 4, contract_version: 5 })],
        ["no contract revision", withContract({ contract_version: 0 })],
        ["a different event window", withContract({ event_window_ms: 300_000 })],
        ["a different duration bucket threshold", withContract({ duration_bucket_threshold_ms: 30_000 })],
        ["no duration bucket threshold", withoutContractField("duration_bucket_threshold_ms")],
        ["a replay age beyond seven days", withContract({ max_request_replay_age_ms: 604_800_001 })],
        ["no replay age", withoutContractField("max_request_replay_age_ms")],
        [
            "a write row limit above the client hard limit",
            withContract({ max_write_rows: USAGE_GRANT_HARD_LIMITS.maxWriteRows + 1 }),
        ],
        ["a device id the service does not derive", { ...fixtureGrant(), device_id: "device-1" }],
        ["an upper-case device id", { ...fixtureGrant(), device_id: "dev_0123456789ABCDEF0123456789ABCDEF" }],
        ["a usage grant without the usage scope", { ...fixtureGrant(), scopes: ["error"] }],
    ])("refuses a grant with %s", (_case, grant) => {
        expect(parseAtomicDeviceGrant(grant)).toBeUndefined()
    })

    it("accepts a production grant that carries its own scopes", () => {
        const grant = parseAtomicDeviceGrant({ ...fixtureGrant(), profile: "production", scopes: ["error", "runtime"] })

        expect(grant).toMatchObject({ profile: "production", scopes: ["error", "runtime"] })
    })
})
