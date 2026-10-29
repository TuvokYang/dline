import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "vitest"
import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import { getDistinctId, setDistinctIdForTesting } from "@/services/logging/distinctId"
import { OpenTelemetryTelemetryProvider } from "../OpenTelemetryTelemetryProvider"

function makeUserInfo(id = "account-1"): ClineAccountUserInfo {
    return {
        id,
        displayName: "Test User",
        email: "test@example.com",
        createdAt: new Date().toISOString(),
        organizations: [
            {
                active: true,
                memberId: "member-1",
                name: "Org A",
                organizationId: "org-a",
                roles: ["admin"],
            },
        ],
    }
}

describe("OpenTelemetryTelemetryProvider identity boundaries", () => {
    let logExporter: InMemoryLogRecordExporter
    let loggerProvider: LoggerProvider
    let provider: OpenTelemetryTelemetryProvider

    beforeEach(() => {
        setDistinctIdForTesting("device-123")
        logExporter = new InMemoryLogRecordExporter()
        loggerProvider = new LoggerProvider()
        loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter))
        provider = new OpenTelemetryTelemetryProvider(null, loggerProvider, { name: "test-otel" })
    })

    afterEach(() => {
        setDistinctIdForTesting("")
    })

    it("emits account identity as a dedicated account log without changing the device id", () => {
        provider.identifyUser(makeUserInfo())

        const records = logExporter.getFinishedLogRecords()
        expect(records).to.have.length(1)
        expect(records[0].body).to.equal("account.identified")
        expect(records[0].attributes).to.deep.equal({
            telemetry_channel: "account",
            telemetry_severity: "info",
            account_id: "account-1",
        })
        expect(getDistinctId()).to.equal("device-123")
    })

    it("deduplicates one account but records an account switch", () => {
        provider.identifyUser(makeUserInfo("account-1"))
        provider.identifyUser(makeUserInfo("account-1"))
        provider.identifyUser(makeUserInfo("account-2"))

        const records = logExporter.getFinishedLogRecords()
        expect(records.map((record) => record.attributes.account_id)).to.deep.equal(["account-1", "account-2"])
        expect(getDistinctId()).to.equal("device-123")
    })

    it("does not attach account or organization identity to ordinary events", () => {
        provider.identifyUser(makeUserInfo())
        logExporter.reset()

        provider.log("usage_event", { telemetry_channel: "usage", provider: "openai-codex" })

        const [record] = logExporter.getFinishedLogRecords()
        expect(record.attributes.distinct_id).to.equal("device-123")
        expect(record.attributes.account_id).to.equal(undefined)
        expect(record.attributes.user_id).to.equal(undefined)
        expect(record.attributes.organization_id).to.equal(undefined)
        expect(record.attributes.member_id).to.equal(undefined)
    })

    it("uses the device distinct_id for every consented product and diagnostic event channel", () => {
        provider.log("usage_event", { telemetry_channel: "usage", provider: "openai-codex" })
        provider.log("runtime_event", { telemetry_channel: "runtime", modelId: "gpt-5.3-codex" })
        provider.log("error_event", { telemetry_channel: "error", apiFormat: "openai-responses" })

        const records = logExporter.getFinishedLogRecords()
        expect(records[0].attributes.distinct_id).to.equal("device-123")
        expect(records[1].attributes.distinct_id).to.equal("device-123")
        expect(records[2].attributes.distinct_id).to.equal("device-123")
    })
})
