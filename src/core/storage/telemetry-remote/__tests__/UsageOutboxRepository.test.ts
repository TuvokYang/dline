import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { emptyUsageOutbox, sha256Hex, type UsageOutboxState } from "@/services/telemetry/remote/usage/usageOutbox"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { USAGE_OUTBOX_SCHEMA_VERSION, USAGE_SENDER_LEASE_MS, UsageOutboxRepository } from "../UsageOutboxRepository"

const REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
const OTHER_REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a02"

function pendingState(policyEpoch = 1): UsageOutboxState {
    return {
        ...emptyUsageOutbox(policyEpoch),
        nextEligibleAt: 1_900_000_120_000,
        windows: [
            {
                startedAt: 1_899_999_960_000,
                counters: { "dline.usage.tokens.input.task": 12 },
                measurements: { "dline.usage.request_duration_ms.task": { count: 2, sum: 30, min: 10, max: 20 } },
            },
        ],
    }
}

describe("UsageOutboxRepository", () => {
    let root: string
    let layout: OtelStorageLayout
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-outbox-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        now = 1_900_000_000_000
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(): UsageOutboxRepository {
        return new UsageOutboxRepository(layout, { clock: () => now })
    }

    it("grants one live lease, renews it in place and hands an expired one over under a new generation", async () => {
        const first = await repository().claim("window-a")
        const contender = await repository().claim("window-b")
        now += USAGE_SENDER_LEASE_MS - 1
        const renewed = await repository().claim("window-a")
        now += USAGE_SENDER_LEASE_MS
        const takeover = await repository().claim("window-b")

        expect(first).toEqual({ ownerId: "window-a", generation: 1 })
        expect(contender).toBeUndefined()
        expect(renewed).toEqual(first)
        expect(takeover).toEqual({ ownerId: "window-b", generation: 2 })
    })

    it("fences off a sender whose lease lapsed or changed hands, and keeps the new owner's lease on a stale release", async () => {
        const stale = await repository().claim("window-a")
        now += USAGE_SENDER_LEASE_MS
        const current = await repository().claim("window-b")
        if (!stale || !current) throw new Error("expected both claims to succeed in turn")

        const fenced = await repository().transact(stale, () => ({ state: pendingState(), result: "stale write" }))
        await repository().release(stale)
        const committed = await repository().transact(current, () => ({ state: pendingState(), result: "current write" }))

        expect(fenced).toEqual({ status: "fenced" })
        expect(committed).toEqual({ status: "committed", result: "current write" })
        expect(await repository().claim("window-a")).toBeUndefined()
    })

    it("fences off the holder itself once its lease expired without renewal", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        now += USAGE_SENDER_LEASE_MS

        expect(await repository().transact(grant, () => ({ state: pendingState(), result: undefined }))).toEqual({
            status: "fenced",
        })
        expect(await repository().read()).toEqual(emptyUsageOutbox(0))
    })

    it("lets exactly one of two racing windows take the lease", async () => {
        const grants = await Promise.all([repository().claim("window-a"), repository().claim("window-b")])

        expect(grants.filter((grant) => grant !== undefined)).toHaveLength(1)
    })

    it("persists the committed state, including the inflight manifest, for the next reader", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        const body = new TextEncoder().encode('{"schema_version":1}')
        const state: UsageOutboxState = {
            ...pendingState(),
            inflight: {
                requestId: REQUEST_ID,
                bodySha256: sha256Hex(body),
                windows: pendingState().windows,
                droppedWindows: 2,
                createdAt: now,
                attempts: 1,
                notBefore: now + 30_000,
            },
        }

        await repository().transact(grant, async () => {
            await repository().writeBody(REQUEST_ID, body)
            return { state, result: undefined }
        })

        const replayed = await repository().readBody(state.inflight as NonNullable<UsageOutboxState["inflight"]>)
        expect(await repository().read()).toEqual(state)
        expect(replayed && new TextDecoder().decode(replayed)).toBe('{"schema_version":1}')
    })

    it("refuses bytes that no longer match the manifest and removes every body except the kept one", async () => {
        const body = new TextEncoder().encode('{"a":1}')
        await repository().writeBody(REQUEST_ID, body)
        await repository().writeBody(OTHER_REQUEST_ID, body)
        await fs.writeFile(path.join(layout.usageInflightDir, `${OTHER_REQUEST_ID}.bin`), '{"a":2}')

        const tampered = await repository().readBody({ requestId: OTHER_REQUEST_ID, bodySha256: sha256Hex(body) })
        await repository().removeBodies(REQUEST_ID)

        expect(tampered).toBeUndefined()
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([`${REQUEST_ID}.bin`])
        await expect(repository().writeBody("../escape", body)).rejects.toThrow()
    })

    it("resets pending work from any window while keeping the lease and the server gate", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        await repository().transact(grant, () => ({ state: pendingState(), result: undefined }))
        await repository().writeBody(REQUEST_ID, new Uint8Array([1, 2, 3]))

        await repository().reset(9)

        expect(await repository().read()).toEqual({ ...emptyUsageOutbox(9), nextEligibleAt: pendingState().nextEligibleAt })
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        expect(await repository().claim("window-b")).toBeUndefined()
    })

    it("quarantines an unreadable outbox and starts over instead of guessing its contents", async () => {
        await fs.mkdir(layout.usageDir, { recursive: true })
        await fs.writeFile(layout.usageOutboxPath, '{"schema_version":1,"generation":"x"}')

        const grant = await repository().claim("window-a")

        expect(grant).toEqual({ ownerId: "window-a", generation: 1 })
        expect(await fs.readdir(layout.remoteQuarantineDir)).toHaveLength(1)
    })

    it("leaves an outbox written by a newer Dline untouched and never sends from it", async () => {
        const newer = `${JSON.stringify({ schema_version: USAGE_OUTBOX_SCHEMA_VERSION + 1, generation: 4 })}\n`
        await fs.mkdir(layout.usageInflightDir, { recursive: true })
        await fs.writeFile(layout.usageOutboxPath, newer)
        await fs.writeFile(path.join(layout.usageInflightDir, `${REQUEST_ID}.bin`), "newer body")

        const grant = await repository().claim("window-a")
        await repository().reset(2)

        expect(grant).toBeUndefined()
        expect(await repository().read()).toBeUndefined()
        expect(await fs.readFile(layout.usageOutboxPath, "utf8")).toBe(newer)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([`${REQUEST_ID}.bin`])
    })
})
