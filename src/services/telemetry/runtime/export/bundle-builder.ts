import { createHash } from "node:crypto"
import type { RootCauseDiagnosis } from "../analysis/root-cause-types"
import type { RuntimeTelemetryEvent } from "../types"
import {
    BUNDLE_ENTRIES,
    type BundleChecksums,
    type BundleManifest,
    defaultBundleEntryNames,
    REDACTION_MARKERS,
    redactBundleValue,
    scrubSecretText,
} from "./bundle-contract"

/**
 * Assembles the in-memory contents of a diagnostic bundle.
 *
 * Building and writing are separate concerns: the archive writer deals with
 * file handles, temp paths, and the host save dialog, while this module owns
 * what the bundle is allowed to contain. Keeping them apart is what makes the
 * privacy rules testable without touching the disk.
 */

/** Environment facts that help interpret timings without identifying the user. */
export interface BundleEnvironment {
    readonly platform: string
    readonly arch: string
    readonly nodeVersion: string
    readonly hostVersion: string
    readonly extensionVersion: string
    readonly cpuCount: number
    readonly totalMemoryBytes: number
}

/**
 * One replayable step.
 *
 * Steps describe what happened, never what was said. `outcome` is a controlled
 * vocabulary rather than free text so a replay harness can branch on it.
 */
export interface ScenarioStep {
    readonly index: number
    readonly component: string
    readonly operation: string
    readonly outcome: string
    readonly durationMs?: number
    readonly offsetMs: number
}

export interface BundleInput {
    readonly sessionId: string
    readonly createdAt: number
    readonly events: readonly RuntimeTelemetryEvent[]
    readonly diagnoses: readonly RootCauseDiagnosis[]
    readonly environment: BundleEnvironment
    readonly buildId?: string
    /**
     * Raw artifacts the user explicitly selected.
     *
     * Empty by default. The builder still redacts them, because consent to
     * attach a file is not consent to leak a credential inside it.
     */
    readonly rawArtifacts?: readonly RawArtifact[]
}

export interface RawArtifact {
    readonly name: string
    readonly content: string
}

/** Raised when a consented artifact cannot be attached safely. */
export class UnsafeRawArtifact extends Error {
    constructor(message: string) {
        super(message)
        this.name = "UnsafeRawArtifact"
    }
}

export interface BuiltBundleEntry {
    readonly name: string
    readonly content: string
}

export interface BuiltBundle {
    readonly manifest: BundleManifest
    readonly entries: readonly BuiltBundleEntry[]
    readonly checksums: BundleChecksums
}

/** Prefix under which consented raw artifacts are stored. */
const RAW_ARTIFACT_PREFIX = "raw/"

/** Artifact names are archive entries, not paths: no traversal, no separators. */
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Names Windows refuses to create regardless of extension.
 *
 * A bundle that cannot be unpacked on the reporter's own machine is a broken
 * bundle, so these are rejected at build time rather than at extraction time.
 */
const WINDOWS_RESERVED_NAMES = new Set([
    "con",
    "prn",
    "aux",
    "nul",
    ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

function sha256(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex")
}

/**
 * Reject artifact names that could escape the `raw/` prefix or collide.
 *
 * Consent covers the file's contents, not an arbitrary archive path: a name
 * like `../../manifest.json` would let an artifact overwrite a bundle entry,
 * and an absolute path would leak the user's directory layout. Collision
 * detection is case-insensitive because the reporter is likely to extract the
 * archive on a case-insensitive filesystem, where `Log.txt` and `log.txt`
 * silently overwrite each other.
 */
function assertSafeArtifactName(name: string, taken: Set<string>): void {
    if (!SAFE_ARTIFACT_NAME.test(name)) {
        throw new UnsafeRawArtifact(`raw artifact name is not a safe archive entry: ${JSON.stringify(name)}`)
    }
    if (name.endsWith(".") || name.endsWith(" ")) {
        throw new UnsafeRawArtifact(`raw artifact name must not end with a dot or space: ${JSON.stringify(name)}`)
    }

    const normalized = name.toLowerCase()
    const stem = normalized.split(".")[0]
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
        throw new UnsafeRawArtifact(`raw artifact name is reserved by the platform: ${name}`)
    }
    if (taken.has(normalized)) {
        throw new UnsafeRawArtifact(`duplicate raw artifact name: ${name}`)
    }
    taken.add(normalized)
}

/**
 * Redact a consented artifact's contents.
 *
 * Consent to attach a file is not consent to leak a credential inside it, so
 * the artifact goes through the same rules as structured entries. Structured
 * content gets the key-based pass; free text gets the credential-shape scrub.
 *
 * Content that announces itself as JSON but does not parse is dropped rather
 * than scrubbed: a truncated or hand-edited object has no reliable token
 * boundaries, so a pattern scan cannot promise that a value survived only
 * because it was safe.
 */
function redactArtifactContent(content: string): string {
    const trimmed = content.trimStart()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return JSON.stringify(redactBundleValue(JSON.parse(content)), null, 2)
        } catch {
            return REDACTION_MARKERS.unsupported
        }
    }
    return scrubSecretText(content)
}

/**
 * Subsystem a step belongs to, derived from the event name.
 *
 * `recordDiagnostic` emits `diagnostic.<domain>.<kind>` without a `component`
 * attribute, so taking the first segment would label every diagnostic as the
 * literal `diagnostic` — a name no replay category claims, which makes a
 * self-produced scenario refuse to replay. The subsystem is the segment after
 * that prefix.
 */
function componentFromEventName(name: string): string {
    const segments = name.split(".")
    if (segments[0] === "diagnostic" && segments.length > 1) {
        return segments[1]
    }
    return segments[0]
}

/**
 * Convert events into replay steps.
 *
 * The offset is relative to the first event so a reader can see the shape of
 * the session without learning when the user was working.
 */
function buildScenarioSteps(events: readonly RuntimeTelemetryEvent[]): ScenarioStep[] {
    if (events.length === 0) return []
    const origin = events[0].timestamp

    return events.map((event, index) => {
        const attributes = event.attributes
        const durationMs = typeof attributes.durationMs === "number" ? attributes.durationMs : undefined
        const component = typeof attributes.component === "string" ? attributes.component : componentFromEventName(event.name)
        const operation = typeof attributes.operation === "string" ? attributes.operation : event.name
        const outcome = typeof attributes.outcome === "string" ? attributes.outcome : event.error ? "failed" : "observed"

        return {
            index,
            component,
            operation,
            outcome,
            durationMs,
            offsetMs: Math.max(0, event.timestamp - origin),
        }
    })
}

/**
 * Build the bundle contents.
 *
 * Every entry goes through `redactBundleValue`, including events that already
 * passed the runtime attribute policy: the bundle is the last boundary before
 * data leaves the machine, and a second pass costs nothing at export time.
 */
export function buildDiagnosticBundle(input: BundleInput): BuiltBundle {
    const redactedEvents = input.events.map((event) => redactBundleValue(event))
    const eventsContent = redactedEvents.map((event) => JSON.stringify(event)).join("\n")
    const diagnosesContent = JSON.stringify(redactBundleValue(input.diagnoses), null, 2)
    const scenarioContent = JSON.stringify(
        redactBundleValue({
            schemaVersion: 1,
            sessionId: input.sessionId,
            steps: buildScenarioSteps(input.events),
        }),
        null,
        2,
    )
    const environmentContent = JSON.stringify(redactBundleValue(input.environment), null, 2)

    const takenArtifactNames = new Set<string>()
    const rawEntries = (input.rawArtifacts ?? []).map((artifact) => {
        assertSafeArtifactName(artifact.name, takenArtifactNames)
        return {
            name: `${RAW_ARTIFACT_PREFIX}${artifact.name}`,
            content: redactArtifactContent(artifact.content),
        }
    })

    const manifest: BundleManifest = {
        schemaVersion: 1,
        sessionId: input.sessionId,
        createdAt: input.createdAt,
        extensionVersion: input.environment.extensionVersion,
        buildId: input.buildId,
        entries: [...defaultBundleEntryNames(), ...rawEntries.map((entry) => entry.name)],
        eventCount: input.events.length,
        diagnosisCount: input.diagnoses.length,
        includesRawArtifacts: rawEntries.length > 0,
    }

    // Checksums cover every entry except the checksum file itself, which
    // cannot hash its own contents.
    const hashedEntries: BuiltBundleEntry[] = [
        { name: BUNDLE_ENTRIES.manifest, content: JSON.stringify(manifest, null, 2) },
        { name: BUNDLE_ENTRIES.events, content: eventsContent },
        { name: BUNDLE_ENTRIES.diagnoses, content: diagnosesContent },
        { name: BUNDLE_ENTRIES.scenario, content: scenarioContent },
        { name: BUNDLE_ENTRIES.environment, content: environmentContent },
        ...rawEntries,
    ]

    const checksums: Record<string, string> = {}
    for (const entry of hashedEntries) {
        checksums[entry.name] = sha256(entry.content)
    }

    return {
        manifest,
        entries: [...hashedEntries, { name: BUNDLE_ENTRIES.checksums, content: JSON.stringify(checksums, null, 2) }],
        checksums,
    }
}

/**
 * Parse the serialized checksum entry, or report that it is unusable.
 *
 * The verifier must not trust `bundle.checksums` alone: that field is the
 * in-memory table, while `checksums.json` is what a recipient actually reads.
 * If the two disagree, the archive is what lies.
 */
function parseChecksumEntry(content: string): BundleChecksums | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(content)
    } catch {
        return undefined
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return undefined
    }

    // A null-prototype accumulator: assigning `__proto__` on a normal object
    // hits the inherited setter instead of creating an own key, which would
    // make a forged entry of that name vanish from the comparison below.
    const table = Object.create(null) as Record<string, string>
    for (const [name, digest] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof digest !== "string") return undefined
        table[name] = digest
    }
    return table
}

/**
 * Recompute checksums and report every entry that fails verification.
 *
 * Verification walks four sets — the manifest listing, the actual entries, the
 * in-memory checksum table and the serialized `checksums.json` — because
 * content hashing alone cannot detect an entry that was deleted, duplicated,
 * added, or rewritten together with its own digest.
 */
export function verifyBundleChecksums(bundle: BuiltBundle): readonly string[] {
    const problems: string[] = []
    const seen = new Set<string>()
    let checksumEntryContent: string | undefined

    for (const entry of bundle.entries) {
        if (seen.has(entry.name)) {
            problems.push(entry.name)
            continue
        }
        seen.add(entry.name)
        if (entry.name === BUNDLE_ENTRIES.checksums) {
            checksumEntryContent = entry.content
            continue
        }

        const expected = bundle.checksums[entry.name]
        if (expected === undefined || expected !== sha256(entry.content)) {
            problems.push(entry.name)
        }
    }

    // An entry named in the checksum table but missing from the archive is as
    // much a corruption as a content mismatch.
    for (const name of Object.keys(bundle.checksums)) {
        if (!seen.has(name)) problems.push(name)
    }

    // The serialized table is the recipient's only view of the digests, so a
    // missing, malformed or divergent `checksums.json` invalidates the bundle
    // even when every other hash matches.
    if (checksumEntryContent === undefined) {
        problems.push(BUNDLE_ENTRIES.checksums)
    } else {
        const serialized = parseChecksumEntry(checksumEntryContent)
        if (serialized === undefined) {
            problems.push(BUNDLE_ENTRIES.checksums)
        } else {
            const names = new Set([...Object.keys(bundle.checksums), ...Object.keys(serialized)])
            for (const name of names) {
                if (bundle.checksums[name] !== serialized[name]) problems.push(name)
            }
        }
    }

    // The manifest is the reader-facing catalogue, and the recipient reads the
    // archived `manifest.json` rather than the in-memory object. Parsing the
    // entry is what makes a rewritten catalogue detectable; comparing the
    // in-memory object against itself would not be.
    const manifestListing = readManifestListing(bundle)
    if (manifestListing === undefined) {
        problems.push(BUNDLE_ENTRIES.manifest)
        return [...new Set(problems)]
    }

    const manifestEntries = new Set<string>(manifestListing)
    if (manifestEntries.size !== manifestListing.length) {
        problems.push(BUNDLE_ENTRIES.manifest)
    }
    for (const name of manifestEntries) {
        if (!seen.has(name)) problems.push(name)
    }
    for (const name of seen) {
        if (name !== BUNDLE_ENTRIES.checksums && !manifestEntries.has(name)) problems.push(name)
    }

    return [...new Set(problems)]
}

/**
 * Read the entry listing a recipient would see.
 *
 * Prefers the archived `manifest.json`, falling back to the in-memory manifest
 * only when the entry is absent — an absence the caller reports separately.
 * Returns `undefined` when the archived manifest cannot be parsed or disagrees
 * with the in-memory object, because either condition means the catalogue the
 * reader gets is not the one this bundle claims to have.
 */
function readManifestListing(bundle: BuiltBundle): readonly string[] | undefined {
    const entry = bundle.entries.find((candidate) => candidate.name === BUNDLE_ENTRIES.manifest)
    if (entry === undefined) return undefined

    let parsed: unknown
    try {
        parsed = JSON.parse(entry.content)
    } catch {
        return undefined
    }
    if (typeof parsed !== "object" || parsed === null) return undefined

    const listing = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(listing) || listing.some((name) => typeof name !== "string")) {
        return undefined
    }

    const archived = listing as string[]
    const inMemory = bundle.manifest.entries
    if (archived.length !== inMemory.length || archived.some((name, index) => name !== inMemory[index])) {
        return undefined
    }
    return archived
}
