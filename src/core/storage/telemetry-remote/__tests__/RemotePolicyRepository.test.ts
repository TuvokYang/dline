import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SERVER_STOP_RETRY_INTERVAL_MS } from "@/services/telemetry/remote/policy/usagePolicy"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { type LocalUsagePolicyInputs, RemotePolicyRepository } from "../RemotePolicyRepository"

const ALLOWED: LocalUsagePolicyInputs = {
    usageConsent: "enabled",
    organizationDisabled: false,
    hostTelemetryLevel: "all",
}

describe("RemotePolicyRepository", () => {
    let root: string
    let layout: OtelStorageLayout
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-policy-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        now = 1_900_000_000_000
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(): RemotePolicyRepository {
        return new RemotePolicyRepository(layout, { clock: () => now })
    }

    it("keeps the epoch while the decision holds and raises it on every change", async () => {
        const policy = repository()

        const first = await policy.resolveUsage(ALLOWED)
        const repeated = await policy.resolveUsage(ALLOWED)
        const disabled = await policy.resolveUsage({ ...ALLOWED, usageConsent: "disabled" })

        expect(first).toEqual({ epoch: now, decision: { allowed: true, profile: "usage" } })
        expect(repeated?.epoch).toBe(first?.epoch)
        expect(disabled).toEqual({ epoch: now + 1, decision: { allowed: false, reason: "consent_off" } })
        expect((await repository().read())?.usage).toEqual(disabled)
    })

    it("does not let a window with a stale view re-enable delivery another window stopped", async () => {
        const windowA = repository()
        const windowB = repository()
        const enabled = await windowA.resolveUsage(ALLOWED)

        await windowB.recordServerStop({ scope: "profile", code: "forbidden" })
        const afterStop = await windowA.resolveUsage(ALLOWED)

        expect(afterStop?.decision).toEqual({ allowed: false, reason: "server_stopped" })
        expect(afterStop?.epoch).toBeGreaterThan(enabled?.epoch ?? Number.POSITIVE_INFINITY)
        expect((await windowA.read())?.serverStop).toEqual({ scope: "profile", code: "forbidden", stoppedAt: now })
    })

    it("holds a refusal for one retry interval, then lets the next resolution try the service again", async () => {
        const policy = repository()
        await policy.resolveUsage(ALLOWED)
        const stopped = await policy.recordServerStop({ scope: "all", code: "edge_blocked" })

        now += SERVER_STOP_RETRY_INTERVAL_MS - 1
        const held = await policy.resolveUsage(ALLOWED)
        now += 1
        const retried = await policy.resolveUsage(ALLOWED)

        expect(held).toEqual(stopped)
        expect(retried).toEqual({ epoch: (stopped?.epoch ?? 0) + 1, decision: { allowed: true, profile: "usage" } })
        expect(await policy.read()).toEqual({ usage: retried })
    })

    it("drops a recorded refusal on the first resolution after a window starts", async () => {
        const policy = repository()
        await policy.resolveUsage(ALLOWED)
        const stopped = await policy.recordServerStop({ scope: "profile", code: "endpoint_unavailable" })

        const otherWindow = await policy.resolveUsage(ALLOWED)
        const startedWindow = await repository().resolveUsage(ALLOWED, { startup: true })

        expect(otherWindow).toEqual(stopped)
        expect(startedWindow?.decision).toEqual({ allowed: true, profile: "usage" })
        expect((await policy.read())?.serverStop).toBeUndefined()
    })

    it("stamps a refusal written without a time by an older build and holds it for a full interval", async () => {
        await fs.mkdir(path.dirname(layout.policyPath), { recursive: true })
        await fs.writeFile(
            layout.policyPath,
            JSON.stringify({
                schema_version: 2,
                usage: { epoch: 7, decision: { allowed: false, reason: "server_stopped" } },
                server_stop: { scope: "all", code: "edge_blocked" },
            }),
        )
        const policy = repository()

        const held = await policy.resolveUsage(ALLOWED)
        const stored = JSON.parse(await fs.readFile(layout.policyPath, "utf8")) as { server_stop?: unknown }
        now += SERVER_STOP_RETRY_INTERVAL_MS
        const retried = await policy.resolveUsage(ALLOWED)

        expect(held).toEqual({ epoch: 7, decision: { allowed: false, reason: "server_stopped" } })
        expect(stored.server_stop).toEqual({
            scope: "all",
            code: "edge_blocked",
            stopped_at: now - SERVER_STOP_RETRY_INTERVAL_MS,
        })
        expect(retried).toEqual({ epoch: 8, decision: { allowed: true, profile: "usage" } })
    })

    it("only re-enables after a stop is cleared and the decision is resolved again", async () => {
        const policy = repository()
        await policy.resolveUsage(ALLOWED)
        const stopped = await policy.recordServerStop({ scope: "all", code: "ip_blocked" })

        await policy.clearServerStop()
        const stillOff = (await policy.read())?.usage
        const resumed = await policy.resolveUsage(ALLOWED)

        expect(stillOff).toEqual(stopped)
        expect(resumed?.decision).toEqual({ allowed: true, profile: "usage" })
        expect(resumed?.epoch).toBe((stopped?.epoch ?? 0) + 1)
    })

    it("reads an unreadable policy as off and restarts the epoch above any earlier one", async () => {
        const policy = repository()
        const before = await policy.resolveUsage(ALLOWED)
        await fs.writeFile(
            layout.policyPath,
            JSON.stringify({ schema_version: 2, usage: { epoch: 3, decision: { allowed: true } } }),
        )

        expect(await policy.read()).toBeUndefined()
        now += 1_000
        const after = await policy.resolveUsage(ALLOWED)

        expect(after?.epoch).toBeGreaterThan(before?.epoch ?? Number.POSITIVE_INFINITY)
        expect(await fs.readdir(layout.remoteQuarantineDir)).toHaveLength(1)
    })

    it("reports a policy it moves aside because it cannot be read at all", async () => {
        await fs.mkdir(layout.remoteDir, { recursive: true })
        await fs.writeFile(layout.policyPath, "{ torn")
        const quarantined: string[] = []
        const policy = new RemotePolicyRepository(layout, { clock: () => now, onQuarantine: (name) => quarantined.push(name) })

        const resolved = await policy.resolveUsage(ALLOWED)
        await policy.resolveUsage(ALLOWED)

        expect(resolved?.decision).toEqual({ allowed: true, profile: "usage" })
        expect(quarantined).toEqual([path.basename(layout.policyPath)])
        expect(await fs.readdir(layout.remoteQuarantineDir)).toHaveLength(1)
    })

    it("continues the epoch of a legacy decision it cannot read and hands older builds a newer owner", async () => {
        await fs.mkdir(layout.remoteDir, { recursive: true })
        const legacy = { schema_version: 1, usage: { epoch: 7, decision: { allowed: false, reason: "development_unenrolled" } } }
        await fs.writeFile(layout.policyPath, JSON.stringify(legacy))
        const quarantined: string[] = []
        const policy = new RemotePolicyRepository(layout, { clock: () => now, onQuarantine: (name) => quarantined.push(name) })

        expect(await policy.read()).toEqual({})
        const resolved = await policy.resolveUsage(ALLOWED)
        // An older build that rewrites its legacy decision is read the same way again, not quarantined.
        await fs.writeFile(layout.policyPath, JSON.stringify({ ...legacy, usage: { ...legacy.usage, epoch: 9 } }))
        const again = await policy.resolveUsage(ALLOWED)
        const stored = JSON.parse(await fs.readFile(layout.policyPath, "utf8")) as { schema_version: number }

        expect(resolved).toEqual({ epoch: 8, decision: { allowed: true, profile: "usage" } })
        expect(again).toEqual({ epoch: 10, decision: { allowed: true, profile: "usage" } })
        expect(quarantined).toEqual([])
        await expect(fs.access(layout.remoteQuarantineDir)).rejects.toThrow()
        // Version 1 readers treat any higher version as a newer owner and stop writing.
        expect(stored.schema_version).toBeGreaterThan(1)
    })

    it("upgrades a legacy document whose decision still holds without moving its epoch", async () => {
        await fs.mkdir(layout.remoteDir, { recursive: true })
        await fs.writeFile(
            layout.policyPath,
            JSON.stringify({ schema_version: 1, usage: { epoch: 4, decision: { allowed: true, profile: "usage" } } }),
        )

        const resolved = await repository().resolveUsage(ALLOWED)
        const stored = JSON.parse(await fs.readFile(layout.policyPath, "utf8")) as { schema_version: number }

        expect(resolved).toEqual({ epoch: 4, decision: { allowed: true, profile: "usage" } })
        expect(stored.schema_version).toBeGreaterThan(1)
    })

    it("treats a policy written by a newer Dline as off and leaves it untouched", async () => {
        await fs.mkdir(layout.remoteDir, { recursive: true })
        const future = JSON.stringify({ schema_version: 3, usage: { epoch: 9, decision: { allowed: true, profile: "usage" } } })
        await fs.writeFile(layout.policyPath, future)
        const policy = repository()

        expect(await policy.read()).toBeUndefined()
        expect(await policy.resolveUsage(ALLOWED)).toBeUndefined()
        expect(await fs.readFile(layout.policyPath, "utf8")).toBe(future)
    })

    it("does not create a policy file when clearing a stop that never existed", async () => {
        await repository().clearServerStop()

        await expect(fs.access(layout.policyPath)).rejects.toThrow()
    })
})
