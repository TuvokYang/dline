import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"

const root = process.cwd()
const scriptRoot = resolve(root, "scripts/perf/ws051-task-runtime")
const harnessReportPath = resolve(root, "tmp/ws051-runtime-performance/report.json")
const artifactPath = resolve(scriptRoot, "task-runtime-performance-baseline.json")
const vitestEntry = resolve(root, "node_modules/vitest/vitest.mjs")

function run(label, command, args, env = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        env: { ...process.env, NO_COLOR: "1", ...env },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
    })
    if (result.status !== 0) {
        throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`)
    }
    return `${result.stdout}\n${result.stderr}`
}

function parseMarker(output, marker) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const matches = [...output.matchAll(new RegExp(`${escaped} (\\{[^\\r\\n]+\\})`, "g"))]
    if (matches.length !== 1) throw new Error(`Expected one ${marker} marker, received ${matches.length}`)
    return JSON.parse(matches[0][1])
}

function compactPromptMetric(metric) {
    const compactSide = (side) => ({
        contextDigest: side.contextDigest,
        contextBytes: side.contextBytes,
        rawContextDigest: side.rawContextDigest,
        rawContextBytes: side.rawContextBytes,
        callDigest: side.callDigest,
        callTrace: side.callTrace,
        taskCapabilityToggles: side.taskCapabilityToggles,
    })
    return {
        unit: metric.unit,
        boundary: metric.boundary,
        legacy: metric.legacy,
        candidate: metric.candidate,
        limit: metric.limit,
        passed: metric.passed,
        equivalence: {
            normalization: metric.equivalence.normalization,
            contextDigest: metric.equivalence.contextDigest,
            contextBytes: metric.equivalence.contextBytes,
            rawContextDigest: metric.equivalence.rawContextDigest,
            rawContextBytes: metric.equivalence.rawContextBytes,
            callDigest: metric.equivalence.callDigest,
            taskCapabilityToggles: metric.equivalence.taskCapabilityToggles,
            legacy: compactSide(metric.equivalence.legacy),
            candidate: compactSide(metric.equivalence.candidate),
        },
    }
}

mkdirSync(dirname(harnessReportPath), { recursive: true })
run("WS-051 isolated performance harness", process.execPath, [resolve(scriptRoot, "run.mjs")], {
    WS051_PERF_OUTPUT: harnessReportPath,
})

const focusedOutput = run("WS-051 focused performance Vitest", process.execPath, [
    vitestEntry,
    "run",
    "src/core/task/performance/TaskRuntimePerformanceGate.test.ts",
    "src/core/task/performance/TaskRuntimeWriteAmplification.test.ts",
])
const harness = JSON.parse(readFileSync(harnessReportPath, "utf8"))
const transition = parseMarker(focusedOutput, "WS-051 candidate transition performance")
const hydrate = parseMarker(focusedOutput, "WS-051 candidate hydrate performance")
const retainedStateDiagnostic = parseMarker(focusedOutput, "WS-051 candidate retained state")
const writeAmplification = parseMarker(focusedOutput, "WS-051 write amplification gate")
const firstPresentation = parseMarker(focusedOutput, "WS-051 deterministic first-presentation gate")

const metrics = {
    coldStart: harness.metrics["cold-start"],
    promptContext: compactPromptMetric(harness.metrics["prompt-context"]),
    firstTokenRuntimeOverhead: {
        ...firstPresentation,
        passed: firstPresentation.presentationP95 <= firstPresentation.limitP95,
    },
    transition: {
        ...transition,
        passed: transition.max <= transition.extensionHostBlockingGateUs,
    },
    hydrate: {
        ...hydrate,
        passed: hydrate.p95 <= hydrate.limitP95,
    },
    retainedMemory: harness.metrics["retained-heap"],
    writeAmplification,
}
const requiredVerdicts = Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, metric?.passed === true]))
const artifact = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    environment: harness.environment,
    commits: harness.commits,
    fixtures: {
        ...harness.fixtures,
        promptContext: "F0 empty discovery with identical leaf I/O, call trace, toggles, and semantic context projection",
        provider: "deterministic one-token provider stub",
        transition: "250 independent ready blocks; each synchronous transition timed separately",
        writeAmplification: "64 KiB prose streamed as 1 chunk and 128 chunks",
    },
    boundaries: {
        coldStart: "fresh Vitest fork dynamically imports the public Task entry",
        promptContext: "capability discovery through immutable SystemPromptContext",
        firstTokenRuntimeOverhead: firstPresentation.boundary,
        transition: "single synchronous kernel transition on the Extension Host",
        hydrate: "dense 250-block crash-recovery hydrate",
        retainedMemory: harness.fixtures.retainedBoundary,
        writeAmplification: "provider partials remain transient; one final payload, journal entry, and event",
    },
    metrics,
    diagnostics: {
        serializedDenseState: retainedStateDiagnostic,
    },
    verification: {
        focusedVitest: { filesPassed: 2, testsPassed: 5, command: "vitest run <two WS-051 performance files>" },
        requiredVerdicts,
        allPassed: Object.values(requiredVerdicts).every(Boolean),
    },
}

if (!artifact.verification.allPassed) {
    throw new Error(`WS-051 performance gate failed: ${JSON.stringify(requiredVerdicts)}`)
}
mkdirSync(dirname(artifactPath), { recursive: true })
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
console.log(`WS-051 final performance artifact written to ${artifactPath}`)
