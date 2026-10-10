import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DiagnosisConfidence, RootCauseCategory, type RootCauseDiagnosis } from "../../analysis/root-cause-types"
import { ReplayPolicy } from "../../reproduction/replay-ports"
import { replayScenario } from "../../reproduction/scenario-runner"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "../../types"
import { type BundleEnvironment, buildDiagnosticBundle, UnsafeRawArtifact, verifyBundleChecksums } from "../bundle-builder"
import {
    BUNDLE_ENTRIES,
    defaultBundleEntryNames,
    isForbiddenBundleField,
    REDACTION_MARKERS,
    redactBundleValue,
} from "../bundle-contract"

const ENVIRONMENT: BundleEnvironment = {
    platform: "win32",
    arch: "x64",
    nodeVersion: "v20.11.0",
    hostVersion: "1.96.0",
    extensionVersion: "0.9.1",
    cpuCount: 8,
    totalMemoryBytes: 34_359_738_368,
}

function event(overrides: Partial<RuntimeTelemetryEvent> = {}): RuntimeTelemetryEvent {
    return {
        eventId: "evt-1",
        sequence: 1,
        timestamp: 1_000,
        monotonicMs: 10,
        name: "terminal.execute_complete",
        priority: RuntimeEventPriority.Performance,
        context: { sessionId: "session-1" },
        attributes: { component: "terminal", operation: "execute", outcome: "succeeded", durationMs: 42 },
        ...overrides,
    }
}

function diagnosis(): RootCauseDiagnosis {
    return {
        incidentId: "incident-1",
        category: RootCauseCategory.ProviderUpstreamLatency,
        confidence: DiagnosisConfidence.High,
        component: "provider",
        operation: "stream",
        evidenceEventIds: ["evt-1", "evt-2"],
        failingEventId: "evt-2",
        reproductionSteps: ["start a task", "wait for the first chunk"],
    }
}

describe("bundle contract", () => {
    it("treats content and credential field names as forbidden", () => {
        for (const name of [
            "command",
            "prompt",
            "stdout",
            "Authorization",
            "pairing_code",
            "apiKey",
            "access_token",
            "refreshToken",
            "idToken",
            "clientSecret",
            "privateKey",
            "proxy-authorization",
            "set-cookie",
            "x-api-key",
        ]) {
            expect(isForbiddenBundleField(name)).toBe(true)
        }
    })

    it("matches credential fragments inside longer field names", () => {
        // An exact-name denylist misses the shapes SDKs actually emit; a field
        // is dangerous because of the credential it carries, not because its
        // name happens to be spelled the way the list expected.
        for (const name of [
            "secretAccessKey",
            "xAuthToken",
            "access.token",
            "userPassword",
            "db_credential",
            "sessionToken",
            "HTTP_PROXY_AUTHORIZATION",
        ]) {
            expect(isForbiddenBundleField(name)).toBe(true)
        }
    })

    it("keeps identity, timing and outcome field names", () => {
        for (const name of ["component", "operation", "outcome", "durationMs", "sessionId", "taskId"]) {
            expect(isForbiddenBundleField(name)).toBe(false)
        }
    })

    it("keeps prose that merely mentions a credential word", () => {
        // Redacting "password reset email sent" would destroy the diagnostic
        // value of the line without protecting anything: there is no value
        // after the word, only a description of what happened.
        const redacted = redactBundleValue({
            outcome: "password reset email sent",
            operation: "rotated the secret sauce recipe",
        }) as Record<string, string>

        expect(redacted.outcome).toBe("password reset email sent")
        expect(redacted.operation).toBe("rotated the secret sauce recipe")
    })

    it("scrubs bare bearer headers and credentials carried in a URL", () => {
        const redacted = redactBundleValue({
            outcome: "Bearer CANARYtokenvalue0123456789",
            operation: "GET /v1/models?api_key=CANARYqueryvalue&page=2",
        }) as Record<string, string>

        expect(redacted.outcome).not.toContain("CANARYtokenvalue0123456789")
        expect(redacted.operation).not.toContain("CANARYqueryvalue")
        // The scrub stops at the parameter boundary so the rest stays readable.
        expect(redacted.operation).toContain("page=2")
    })

    it("empties forbidden fields at any nesting depth but keeps the key", () => {
        const redacted = redactBundleValue({
            component: "terminal",
            command: "rm -rf /",
            nested: { prompt: "secret question", durationMs: 5 },
            list: [{ token: "abc", outcome: "failed" }],
        }) as Record<string, unknown>

        expect(redacted.component).toBe("terminal")
        // The key survives so a reader can tell the exporter removed the value
        // instead of the producer never recording it.
        expect(redacted.command).toBe(REDACTION_MARKERS.forbidden)
        expect(redacted.nested).toEqual({ prompt: REDACTION_MARKERS.forbidden, durationMs: 5 })
        expect(redacted.list).toEqual([{ token: REDACTION_MARKERS.forbidden, outcome: "failed" }])
    })

    it("scrubs credential shapes hidden inside allowed fields", () => {
        const redacted = redactBundleValue({
            operation: "retry after Authorization: Bearer abcdef0123456789",
            note: "key sk-abcdefghijklmnopqrstuvwx failed",
            outcome: "failed",
        }) as Record<string, string>

        expect(redacted.operation).not.toContain("abcdef0123456789")
        expect(redacted.operation).toContain(REDACTION_MARKERS.secret)
        expect(redacted.note).not.toContain("sk-abcdefghijklmnopqrstuvwx")
        expect(redacted.outcome).toBe("failed")
    })

    it("refuses functions so toJSON cannot re-inject data later", () => {
        const redacted = redactBundleValue({
            outcome: "failed",
            toJSON: () => ({ command: "rm -rf /" }),
        }) as Record<string, unknown>

        expect(redacted.toJSON).toBe(REDACTION_MARKERS.unsupported)
        expect(JSON.stringify(redacted)).not.toContain("rm -rf")
    })

    it("does not let a __proto__ key mutate the redacted object", () => {
        const hostile = JSON.parse('{"outcome":"failed","__proto__":{"polluted":true}}')
        const redacted = redactBundleValue(hostile) as Record<string, unknown>

        expect(redacted.outcome).toBe("failed")
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    it("marks cycles and over-deep nesting instead of dropping them silently", () => {
        const cyclic: Record<string, unknown> = { outcome: "failed" }
        cyclic.self = cyclic
        expect((redactBundleValue(cyclic) as Record<string, unknown>).self).toBe(REDACTION_MARKERS.circular)

        let deep: Record<string, unknown> = { outcome: "failed" }
        for (let i = 0; i < 12; i++) deep = { nested: deep }
        expect(JSON.stringify(redactBundleValue(deep))).toContain(REDACTION_MARKERS.depthLimit)
    })

    it("marks non-JSON containers rather than serializing them as empty objects", () => {
        const redacted = redactBundleValue({
            set: new Set([1, 2]),
            map: new Map([["a", 1]]),
            bytes: new Uint8Array([1, 2, 3]),
        }) as Record<string, unknown>

        expect(redacted.set).toBe(REDACTION_MARKERS.unsupported)
        expect(redacted.map).toBe(REDACTION_MARKERS.unsupported)
        expect(redacted.bytes).toBe(REDACTION_MARKERS.unsupported)
    })
})

describe("buildDiagnosticBundle", () => {
    it("writes the default entries in contract order", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1_700_000_000_000,
            events: [event()],
            diagnoses: [diagnosis()],
            environment: ENVIRONMENT,
        })

        expect(bundle.entries.map((entry) => entry.name)).toEqual([...defaultBundleEntryNames()])
    })

    it("excludes raw artifacts unless the user selected them", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [event()],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        expect(bundle.manifest.includesRawArtifacts).toBe(false)
        expect(bundle.entries.some((entry) => entry.name.startsWith("raw/"))).toBe(false)
    })

    it("redacts consented raw artifacts instead of trusting the consent", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [],
            diagnoses: [],
            environment: ENVIRONMENT,
            rawArtifacts: [
                {
                    name: "notes.json",
                    content: '{"outcome":"failed","apiKey":"CANARY-STRUCTURED-SECRET"}',
                },
                {
                    name: "session.log",
                    content: "connect ok\nAuthorization: Bearer CANARY-TEXT-SECRET-0123456789\nretry",
                },
            ],
        })

        expect(bundle.manifest.includesRawArtifacts).toBe(true)

        const json = bundle.entries.find((entry) => entry.name === "raw/notes.json")
        expect(json?.content).toContain("failed")
        expect(json?.content).not.toContain("CANARY-STRUCTURED-SECRET")
        expect(json?.content).toContain(REDACTION_MARKERS.forbidden)

        const log = bundle.entries.find((entry) => entry.name === "raw/session.log")
        expect(log?.content).toContain("connect ok")
        expect(log?.content).not.toContain("CANARY-TEXT-SECRET-0123456789")

        // Checksums must cover the redacted content, not the original.
        expect(verifyBundleChecksums(bundle)).toEqual([])
    })

    it("drops structured content that announces itself as JSON but does not parse", () => {
        // A truncated or hand-edited object has no reliable token boundaries,
        // so a pattern scan cannot promise that a surviving value was safe.
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [],
            diagnoses: [],
            environment: ENVIRONMENT,
            rawArtifacts: [{ name: "truncated.json", content: '{"access_token":"CANARY-TRAILING-SECRET"}x' }],
        })

        const entry = bundle.entries.find((item) => item.name === "raw/truncated.json")
        expect(entry?.content).toBe(REDACTION_MARKERS.unsupported)
        expect(entry?.content).not.toContain("CANARY-TRAILING-SECRET")
    })

    it("rejects artifact names that could escape the raw prefix or collide", () => {
        const build = (name: string) =>
            buildDiagnosticBundle({
                sessionId: "session-1",
                createdAt: 1,
                events: [],
                diagnoses: [],
                environment: ENVIRONMENT,
                rawArtifacts: [{ name, content: "ok" }],
            })

        for (const name of [
            "../manifest.json",
            "nested/notes.json",
            "C:\\keys.txt",
            "/etc/passwd",
            "..",
            "no\u0000tes",
            // Windows refuses these regardless of extension, so a bundle
            // containing one cannot be unpacked by the reporter who made it.
            "CON",
            "nul.log",
            "com1.txt",
            "trailing.",
        ]) {
            expect(() => build(name)).toThrow(UnsafeRawArtifact)
        }

        expect(() =>
            buildDiagnosticBundle({
                sessionId: "session-1",
                createdAt: 1,
                events: [],
                diagnoses: [],
                environment: ENVIRONMENT,
                rawArtifacts: [
                    { name: "notes.log", content: "a" },
                    // A case-insensitive filesystem would overwrite the first
                    // entry on extraction, silently losing evidence.
                    { name: "Notes.LOG", content: "b" },
                ],
            }),
        ).toThrow(UnsafeRawArtifact)
    })

    it("keeps content out of the serialized events", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [
                event({
                    attributes: {
                        component: "terminal",
                        operation: "execute",
                        // A producer that bypassed the attribute policy.
                        command: "cat ~/.ssh/id_rsa",
                    } as never,
                }),
            ],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const events = bundle.entries.find((entry) => entry.name === BUNDLE_ENTRIES.events)
        expect(events?.content).toContain("terminal")
        expect(events?.content).not.toContain("id_rsa")
        // The key stays as evidence that the exporter removed a value.
        expect(events?.content).toContain(REDACTION_MARKERS.forbidden)
    })

    it("derives replay steps with offsets relative to the first event", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [
                event({ eventId: "evt-1", timestamp: 5_000 }),
                event({ eventId: "evt-2", timestamp: 5_250, name: "provider.stream_failed" }),
            ],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const scenario = JSON.parse(bundle.entries.find((entry) => entry.name === BUNDLE_ENTRIES.scenario)?.content ?? "{}")
        expect(scenario.steps).toHaveLength(2)
        expect(scenario.steps[0].offsetMs).toBe(0)
        expect(scenario.steps[1].offsetMs).toBe(250)
    })

    it("labels a diagnostic event with its subsystem so the scenario can replay", () => {
        // `recordDiagnostic` emits `diagnostic.<domain>.<kind>` and sets no
        // `component` attribute. Falling back to the first name segment would
        // stamp every such step as `diagnostic`, which no replay category
        // claims, so replaying a bundle this codebase produced would refuse at
        // the first diagnostic.
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [
                event({
                    name: "diagnostic.storage.stale_lock_broken",
                    attributes: { outcome: "recovered" },
                }),
            ],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const scenario = JSON.parse(bundle.entries.find((entry) => entry.name === BUNDLE_ENTRIES.scenario)?.content ?? "{}")
        expect(scenario.steps[0].component).toBe("storage")
        expect(() => replayScenario(scenario.steps, ReplayPolicy.Simulate)).not.toThrow()
    })

    it("checksums every entry except the checksum file", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [event()],
            diagnoses: [diagnosis()],
            environment: ENVIRONMENT,
        })

        expect(bundle.checksums).not.toHaveProperty(BUNDLE_ENTRIES.checksums)
        const manifestEntry = bundle.entries.find((entry) => entry.name === BUNDLE_ENTRIES.manifest)
        expect(bundle.checksums[BUNDLE_ENTRIES.manifest]).toBe(
            createHash("sha256")
                .update(manifestEntry?.content ?? "", "utf8")
                .digest("hex"),
        )
        expect(verifyBundleChecksums(bundle)).toEqual([])
    })

    it("reports entries whose content no longer matches the recorded checksum", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [event()],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const tampered = {
            ...bundle,
            entries: bundle.entries.map((entry) =>
                entry.name === BUNDLE_ENTRIES.environment ? { ...entry, content: "{}" } : entry,
            ),
        }

        expect(verifyBundleChecksums(tampered)).toEqual([BUNDLE_ENTRIES.environment])
    })

    it("reports removed, duplicated and unlisted entries", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [event()],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        const removed = {
            ...bundle,
            entries: bundle.entries.filter((entry) => entry.name !== BUNDLE_ENTRIES.environment),
        }
        expect(verifyBundleChecksums(removed)).toContain(BUNDLE_ENTRIES.environment)

        const duplicated = { ...bundle, entries: [...bundle.entries, bundle.entries[0]] }
        expect(verifyBundleChecksums(duplicated)).toContain(bundle.entries[0].name)

        const smuggled = {
            ...bundle,
            entries: [...bundle.entries, { name: "raw/extra.log", content: "added after the fact" }],
        }
        expect(verifyBundleChecksums(smuggled)).toContain("raw/extra.log")
    })

    it("reports a checksums.json that disagrees with the digests it should carry", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [event()],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        // The serialized table is the recipient's only view of the digests, so
        // rewriting it must not be able to certify a tampered archive.
        const forged = {
            ...bundle,
            entries: bundle.entries.map((entry) =>
                entry.name === BUNDLE_ENTRIES.checksums
                    ? { ...entry, content: JSON.stringify({ ...bundle.checksums, [BUNDLE_ENTRIES.events]: "0".repeat(64) }) }
                    : entry,
            ),
        }
        expect(verifyBundleChecksums(forged)).toContain(BUNDLE_ENTRIES.events)

        const malformed = {
            ...bundle,
            entries: bundle.entries.map((entry) =>
                entry.name === BUNDLE_ENTRIES.checksums ? { ...entry, content: "not json" } : entry,
            ),
        }
        expect(verifyBundleChecksums(malformed)).toContain(BUNDLE_ENTRIES.checksums)
    })

    it("reports a manifest that lists the same entry twice", () => {
        const bundle = buildDiagnosticBundle({
            sessionId: "session-1",
            createdAt: 1,
            events: [event()],
            diagnoses: [],
            environment: ENVIRONMENT,
        })

        // The duplicate has to appear in the archived manifest as well as the
        // in-memory one. Changing only the in-memory copy trips the earlier
        // "archive disagrees with memory" branch and never reaches the
        // duplicate check this test is named for.
        const listing = [...bundle.manifest.entries, BUNDLE_ENTRIES.events]
        const manifest = { ...bundle.manifest, entries: listing }
        const duplicatedListing = {
            ...bundle,
            manifest,
            entries: bundle.entries.map((entry) =>
                entry.name === BUNDLE_ENTRIES.manifest ? { ...entry, content: JSON.stringify(manifest, null, 2) } : entry,
            ),
        }

        const problems = verifyBundleChecksums(duplicatedListing)
        expect(problems).toContain(BUNDLE_ENTRIES.manifest)
        // The rewritten manifest also fails its own digest, but the duplicate
        // must be reported independently of that.
        expect(problems.filter((name) => name === BUNDLE_ENTRIES.manifest)).toHaveLength(1)
    })
})
