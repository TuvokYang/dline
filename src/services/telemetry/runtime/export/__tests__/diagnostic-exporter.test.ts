import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RootCauseDiagnosis } from "../../analysis/root-cause-types"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { BUNDLE_ENTRIES } from "../bundle-contract"
import { type DiagnosticSource, describeEnvironment, exportDiagnosticBundle } from "../diagnostic-exporter"

const CANARY = "CANARY-SECRET-VALUE"

function event(overrides: Partial<RuntimeTelemetryEvent> = {}): RuntimeTelemetryEvent {
    return {
        eventId: "evt-1",
        sequence: 1,
        timestamp: 1_000,
        monotonicMs: 10,
        name: "terminal.execute",
        priority: RuntimeEventPriority.Performance,
        context: { sessionId: "session-1" },
        attributes: { component: "terminal", operation: "execute", durationMs: 42 },
        ...overrides,
    }
}

function source(events: readonly RuntimeTelemetryEvent[], diagnoses: readonly RootCauseDiagnosis[] = []): DiagnosticSource {
    return {
        sessionId: "session-1",
        events: () => events,
        diagnoses: () => diagnoses,
    }
}

describe("describeEnvironment", () => {
    it("reports interpretable facts without identifying the machine", () => {
        const environment = describeEnvironment("1.2.3", "1.90.0")

        expect(environment.extensionVersion).toBe("1.2.3")
        expect(environment.hostVersion).toBe("1.90.0")
        expect(environment.cpuCount).toBeGreaterThan(0)
        // Hostname, username, and workspace path would identify the reporter.
        expect(Object.keys(environment).sort()).toEqual([
            "arch",
            "cpuCount",
            "extensionVersion",
            "hostVersion",
            "nodeVersion",
            "platform",
            "totalMemoryBytes",
        ])
    })
})

describe("exportDiagnosticBundle", () => {
    let directory: string

    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "dline-export-"))
    })

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })

    it("writes an archive and reports the manifest", async () => {
        const destination = path.join(directory, "bundle.zip")

        const result = await exportDiagnosticBundle(source([event()]), {
            destinationPath: destination,
            extensionVersion: "1.2.3",
            hostVersion: "1.90.0",
            now: () => 5_000,
        })

        expect(result.archive.path).toBe(destination)
        expect(result.archive.byteLength).toBeGreaterThan(0)
        expect(result.bundle.manifest.eventCount).toBe(1)
        expect(result.bundle.manifest.createdAt).toBe(5_000)
        expect(result.bundle.manifest.includesRawArtifacts).toBe(false)
    })

    it("omits raw artifacts when consent was not given", async () => {
        const result = await exportDiagnosticBundle(source([event()]), {
            destinationPath: path.join(directory, "bundle.zip"),
            extensionVersion: "1.2.3",
            hostVersion: "1.90.0",
            rawConsent: { confirmed: false, artifacts: [{ name: "conversation.jsonl", content: CANARY }] },
        })

        expect(result.bundle.manifest.includesRawArtifacts).toBe(false)
        const serialized = JSON.stringify(result.bundle)
        expect(serialized).not.toContain(CANARY)
    })

    it("includes raw artifacts only after consent is confirmed", async () => {
        const result = await exportDiagnosticBundle(source([event()]), {
            destinationPath: path.join(directory, "bundle.zip"),
            extensionVersion: "1.2.3",
            hostVersion: "1.90.0",
            rawConsent: { confirmed: true, artifacts: [{ name: "conversation.jsonl", content: "line" }] },
        })

        expect(result.bundle.manifest.includesRawArtifacts).toBe(true)
        expect(result.bundle.entries.some((entry) => entry.name === "raw/conversation.jsonl")).toBe(true)
    })

    it("redacts consented artifacts rather than trusting the consent", async () => {
        const result = await exportDiagnosticBundle(source([event()]), {
            destinationPath: path.join(directory, "bundle.zip"),
            extensionVersion: "1.2.3",
            hostVersion: "1.90.0",
            rawConsent: {
                confirmed: true,
                artifacts: [{ name: "session.log", content: `Authorization: Bearer ${CANARY}-0123456789` }],
            },
        })

        const raw = result.bundle.entries.find((entry) => entry.name === "raw/session.log")
        expect(raw).toBeDefined()
        expect(raw?.content).not.toContain(CANARY)
    })

    it("keeps user content out of the default bundle", async () => {
        // The event carries a canary in a field the content policy would
        // normally reject; the bundle is the last boundary and must strip it.
        const noisy = event({
            attributes: {
                component: "terminal",
                operation: "execute",
                command: CANARY,
                stdout: CANARY,
            } as never,
        })

        const result = await exportDiagnosticBundle(source([noisy]), {
            destinationPath: path.join(directory, "bundle.zip"),
            extensionVersion: "1.2.3",
            hostVersion: "1.90.0",
        })

        const events = result.bundle.entries.find((entry) => entry.name === BUNDLE_ENTRIES.events)
        expect(events?.content).not.toContain(CANARY)
    })

    it("leaves no staging file behind when the destination cannot be written", async () => {
        // A directory occupying the exact destination path makes the rename
        // fail after the archive has already been staged.
        const destination = path.join(directory, "bundle.zip")
        await mkdir(destination)

        await expect(
            exportDiagnosticBundle(source([event()]), {
                destinationPath: destination,
                extensionVersion: "1.2.3",
                hostVersion: "1.90.0",
            }),
        ).rejects.toThrow()

        const remaining = await readdir(directory)
        expect(remaining.filter((name) => name.endsWith(".partial"))).toEqual([])
        expect(remaining).toEqual(["bundle.zip"])
    })
})
