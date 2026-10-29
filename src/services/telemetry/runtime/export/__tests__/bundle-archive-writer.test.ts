import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { BundleArchiveError, writeBundleArchive } from "../bundle-archive-writer"
import { type BundleEnvironment, buildDiagnosticBundle } from "../bundle-builder"

/** Local file header signature that precedes every stored zip entry. */
const ZIP_LOCAL_HEADER = 0x04034b50

/**
 * Names of the entries physically stored in a zip.
 *
 * Read by scanning local file headers rather than by unzipping: the writer's
 * own report cannot prove that anything was appended, and an empty archive is
 * still a non-empty file, so a size assertion alone would pass even if every
 * entry were dropped.
 */
async function archivedEntryNames(path: string): Promise<string[]> {
    const bytes = await readFile(path)
    const names: string[] = []
    for (let offset = 0; offset + 30 <= bytes.length; offset += 1) {
        if (bytes.readUInt32LE(offset) !== ZIP_LOCAL_HEADER) continue
        const nameLength = bytes.readUInt16LE(offset + 26)
        const nameStart = offset + 30
        if (nameStart + nameLength > bytes.length) continue
        names.push(bytes.subarray(nameStart, nameStart + nameLength).toString("utf8"))
    }
    return names
}

const ENVIRONMENT: BundleEnvironment = {
    platform: "linux",
    arch: "x64",
    nodeVersion: "v20.11.0",
    hostVersion: "1.96.0",
    extensionVersion: "0.9.1",
    cpuCount: 4,
    totalMemoryBytes: 8_589_934_592,
}

const EVENT: RuntimeTelemetryEvent = {
    eventId: "evt-1",
    sequence: 1,
    timestamp: 1_000,
    monotonicMs: 10,
    name: "runtime.sample",
    priority: RuntimeEventPriority.Performance,
    context: { sessionId: "session-1" },
    attributes: { component: "runtime", operation: "sample", durationMs: 3 },
}

describe("writeBundleArchive", () => {
    let directory: string

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dline-bundle-"))
    })

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })

    it("writes a non-empty archive at the requested path", async () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [EVENT],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const result = await writeBundleArchive(bundle, join(directory, "nested", "bundle.zip"))

        expect(result.entryCount).toBe(bundle.entries.length)
        expect(result.byteLength).toBeGreaterThan(0)
        expect((await stat(result.path)).size).toBe(result.byteLength)
        // The archive itself must carry every entry, not just the report.
        expect((await archivedEntryNames(result.path)).sort()).toEqual(bundle.entries.map((entry) => entry.name).sort())
    })

    it("leaves no staged file behind after a successful write", async () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [EVENT],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        await writeBundleArchive(bundle, join(directory, "bundle.zip"))

        expect(await readdir(directory)).toEqual(["bundle.zip"])
    })

    it("removes the staged file and reports the path when the write fails", async () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [EVENT],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        // A directory cannot be replaced by a file, so finalize fails after the
        // staged path has been created.
        const destination = join(directory, "occupied")
        const { mkdir } = await import("node:fs/promises")
        await mkdir(destination)

        await expect(writeBundleArchive(bundle, destination)).rejects.toThrow(/occupied/)
        expect(await readdir(directory)).toEqual(["occupied"])
    })

    it("does not let concurrent exports to one destination corrupt each other", async () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [EVENT],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const destination = join(directory, "bundle.zip")
        const results = await Promise.all([
            writeBundleArchive(bundle, destination),
            writeBundleArchive(bundle, destination),
            writeBundleArchive(bundle, destination),
        ])

        // Each attempt staged its own file, so every one committed a complete
        // archive and none truncated a sibling's staging file.
        for (const result of results) {
            expect(result.byteLength).toBeGreaterThan(0)
        }
        expect((await stat(destination)).size).toBeGreaterThan(0)
        expect(await readdir(directory)).toEqual(["bundle.zip"])
    })

    it("reports a failure surfaced while opening the staging stream", async () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [EVENT],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        // A regular file cannot act as a parent directory, so opening the
        // staging stream fails and the error must surface as a wrapped
        // BundleArchiveError rather than an unhandled stream event.
        await writeBundleArchive(bundle, join(directory, "bundle.zip"))
        const blocked = join(directory, "bundle.zip", "inner.zip")

        await expect(writeBundleArchive(bundle, blocked)).rejects.toThrow(BundleArchiveError)
        expect(await readdir(directory)).toEqual(["bundle.zip"])
    })
})
