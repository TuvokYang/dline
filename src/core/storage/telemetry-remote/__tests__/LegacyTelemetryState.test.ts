import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { backupPathOf } from "@shared/storage/atomic-file"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { retireLegacyTelemetryState } from "../LegacyTelemetryState"
import { resolveOtelStorageLayout } from "../OtelStorageLayout"

const NOW = 1_900_000_000_000

describe("retireLegacyTelemetryState", () => {
    let root: string
    let dataDir: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-legacy-telemetry-"))
        dataDir = path.join(root, "data")
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    async function write(filePath: string, content: string): Promise<void> {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, content)
    }

    async function evidence(): Promise<unknown[]> {
        const quarantineDir = resolveOtelStorageLayout(dataDir).remoteQuarantineDir
        const names = (await fs.readdir(quarantineDir)).filter((name) => name.endsWith(".discarded.json")).sort()
        const records = await Promise.all(
            names.map(
                async (name) => JSON.parse(await fs.readFile(path.join(quarantineDir, name), "utf8")) as { document: string },
            ),
        )
        return records.sort((left, right) => left.document.localeCompare(right.document))
    }

    it("deletes what earlier contracts left, keeps current shards, and records only what was lost", async () => {
        const layout = resolveOtelStorageLayout(dataDir)
        const pairing = path.join(dataDir, "secrets", "telemetry-authorization.json")
        const supportOperation = path.join(layout.secretsDir, "support-operation.json")
        const diagnosticsV2 = path.join(layout.remoteDir, "diagnostics", "outbox-v2.json")
        await write(pairing, JSON.stringify({ pairingCredential: { code: "never-redeemed", schemaVersion: 1 } }))
        await write(supportOperation, JSON.stringify({ operation: "support.open" }))
        await write(backupPathOf(diagnosticsV2), JSON.stringify({ schema_version: 2, records: [] }))
        const observations = layout.usageObservationsDir
        await write(path.join(observations, "host-a.jsonl"), '{"logical":true}\n')
        await write(path.join(observations, "host-a.1800000000000.sealed.jsonl"), '{"logical":true}\n')
        await write(path.join(observations, "host-a.attempts.jsonl"), "")
        await write(path.join(observations, "host-b.1800000000000.attempts.sealed.jsonl"), "")

        await retireLegacyTelemetryState(dataDir, NOW)
        await retireLegacyTelemetryState(dataDir, NOW + 1)

        for (const retired of [pairing, supportOperation, diagnosticsV2, backupPathOf(diagnosticsV2)]) {
            await expect(fs.access(retired)).rejects.toThrow()
        }
        expect((await fs.readdir(observations)).sort()).toEqual([
            "host-a.attempts.jsonl",
            "host-b.1800000000000.attempts.sealed.jsonl",
        ])
        // One record per discard, carrying no content of what was deleted; the second run found nothing.
        const discarded = (document: string, counts?: Record<string, number>) => ({
            schema_version: 1,
            kind: "telemetry_state_discarded",
            document,
            reason: "retired_document",
            ...(counts ? { counts } : {}),
            recorded_at: NOW,
        })
        expect(await evidence()).toEqual([
            discarded("diagnostics-outbox-v2"),
            discarded("pairing-credential"),
            discarded("support-operation"),
            discarded("usage-observation-shards", { shards: 2 }),
        ])
    })

    it("creates nothing on a start that finds no earlier state", async () => {
        await retireLegacyTelemetryState(dataDir, NOW)

        await expect(fs.access(dataDir)).rejects.toThrow()
    })
})
