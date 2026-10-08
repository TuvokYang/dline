import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"

const WARMUPS = 5
const MEASUREMENTS = 20
const RUNS = WARMUPS + MEASUREMENTS
const harnessRoot = process.cwd()
const scriptRoot = resolve(harnessRoot, "scripts/perf/ws051-task-runtime")
const legacyRoot = resolve(harnessRoot, process.env.WS051_LEGACY_ROOT ?? "../../WS-051/perf-baseline")
const vitestEntry = resolve(harnessRoot, "node_modules/vitest/vitest.mjs")
const config = resolve(scriptRoot, "vitest.config.ts")
const output = process.env.WS051_PERF_OUTPUT
	? resolve(harnessRoot, process.env.WS051_PERF_OUTPUT)
	: resolve(harnessRoot, "tmp/ws051-runtime-performance/report.json")
mkdirSync(dirname(output), { recursive: true })

function percentile(samples, value) {
	const sorted = [...samples].sort((left, right) => left - right)
	return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0
}

function commit(root) {
	const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
	if (result.status !== 0) throw new Error(result.stderr || `Unable to read commit for ${root}`)
	return result.stdout.trim()
}

function sample(probe, variant, targetRoot, index) {
	const result = spawnSync(process.execPath, [vitestEntry, "run", "--config", config], {
		cwd: harnessRoot,
		env: {
			...process.env,
			NO_COLOR: "1",
			WS051_HARNESS_ROOT: harnessRoot,
			WS051_TARGET_ROOT: targetRoot,
			WS051_VARIANT: variant,
			WS051_PROBE: probe,
			WS051_RUN_ID: `${probe}-${variant}-${index}`,
		},
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(`WS-051 ${probe}/${variant} failed\n${result.stdout}\n${result.stderr}`)
	}
	const matches = [...result.stdout.matchAll(/WS051_SAMPLE (\{[^\r\n]+\})/g)]
	if (matches.length !== 1) throw new Error(`Expected one WS051_SAMPLE for ${probe}/${variant}, received ${matches.length}`)
	const parsed = JSON.parse(matches[0][1])
	if (parsed.metric !== probe.replace("-", "_") || parsed.variant !== variant) {
		throw new Error(`Unexpected sample identity: ${JSON.stringify(parsed)}`)
	}
	return parsed
}

function summarize(samples, field) {
	const measured = samples.slice(WARMUPS)
	const values = measured.map((entry) => entry[field])
	const pids = samples.map((entry) => entry.pid)
	const runIds = samples.map((entry) => entry.runId)
	if (new Set(runIds).size !== RUNS) throw new Error("A WS-051 probe invocation identity was reused")
	return {
		samples: values,
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		pids,
		runIds,
		pidReuseCount: RUNS - new Set(pids).size,
	}
}

function summarizeAggregate(sampleResult, field) {
	if (sampleResult.warmups !== WARMUPS || sampleResult.measurements !== MEASUREMENTS) {
		throw new Error(`Unexpected aggregate sample geometry: ${JSON.stringify(sampleResult)}`)
	}
	const values = sampleResult[field]
	if (!Array.isArray(values) || values.length !== MEASUREMENTS) {
		throw new Error(`Expected ${MEASUREMENTS} aggregate measurements for ${sampleResult.metric}/${sampleResult.variant}`)
	}
	if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error(`Aggregate measurements contain an invalid value for ${sampleResult.metric}/${sampleResult.variant}`)
	}
	return {
		samples: values,
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		pid: sampleResult.pid,
		runId: sampleResult.runId,
	}
}

const roots = { legacy: legacyRoot, candidate: harnessRoot }
const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
	commits: { legacy: commit(legacyRoot), candidate: commit(harnessRoot) },
	fixtures: {
		warmups: WARMUPS,
		measurements: MEASUREMENTS,
		blocksPerFixture: 250,
		retainedReplicas: 128,
		retainedBoundary: "crash recovery complete; task-owned lifecycle authorities retained; effects not re-admitted",
	},
	metrics: {},
}

const probes = (process.env.WS051_PROBES ?? "cold-start,prompt-context,retained-heap").split(",")
for (const probe of probes) {
	if (probe !== "cold-start" && probe !== "prompt-context" && probe !== "retained-heap") {
		throw new Error(`Unsupported WS051 probe: ${probe}`)
	}

	if (probe === "prompt-context") {
		const legacySample = sample(probe, "legacy", roots.legacy, 0)
		const candidateSample = sample(probe, "candidate", roots.candidate, 0)
		const legacy = summarizeAggregate(legacySample, "samplesMs")
		const candidate = summarizeAggregate(candidateSample, "samplesMs")
		const equivalence = {
			normalization: "optional transport booleans are canonicalized with === true; raw contexts remain recorded",
			contextDigest: legacySample.contextDigest === candidateSample.contextDigest,
			contextBytes: legacySample.contextBytes === candidateSample.contextBytes,
			rawContextDigest: legacySample.rawContextDigest === candidateSample.rawContextDigest,
			rawContextBytes: legacySample.rawContextBytes === candidateSample.rawContextBytes,
			callDigest: legacySample.callDigest === candidateSample.callDigest,
			taskCapabilityToggles: legacySample.taskCapabilityToggles === candidateSample.taskCapabilityToggles,
			legacy: {
				contextDigest: legacySample.contextDigest,
				contextBytes: legacySample.contextBytes,
				context: legacySample.context,
				rawContextDigest: legacySample.rawContextDigest,
				rawContextBytes: legacySample.rawContextBytes,
				rawContext: legacySample.rawContext,
				callDigest: legacySample.callDigest,
				callTrace: legacySample.callTrace,
				taskCapabilityToggles: legacySample.taskCapabilityToggles,
			},
			candidate: {
				contextDigest: candidateSample.contextDigest,
				contextBytes: candidateSample.contextBytes,
				context: candidateSample.context,
				rawContextDigest: candidateSample.rawContextDigest,
				rawContextBytes: candidateSample.rawContextBytes,
				rawContext: candidateSample.rawContext,
				callDigest: candidateSample.callDigest,
				callTrace: candidateSample.callTrace,
				taskCapabilityToggles: candidateSample.taskCapabilityToggles,
			},
		}
		const equivalent =
			equivalence.contextDigest && equivalence.contextBytes && equivalence.callDigest && equivalence.taskCapabilityToggles
		const limit = { p95: legacy.p95 * 1.1 }
		const passed = equivalent && candidate.p95 <= limit.p95
		report.metrics[probe] = {
			unit: "milliseconds",
			boundary: "fixed-F0 capability discovery through immutable SystemPromptContext",
			legacy,
			candidate,
			equivalence,
			limit,
			passed,
		}
		console.log(`WS-051 ${probe} ${JSON.stringify(report.metrics[probe])}`)
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
		if (!passed) process.exitCode = 1
		continue
	}

	const collected = { legacy: [], candidate: [] }
	for (let index = 0; index < RUNS; index++) {
		const order = index % 2 === 0 ? ["legacy", "candidate"] : ["candidate", "legacy"]
		for (const variant of order) collected[variant].push(sample(probe, variant, roots[variant], index))
	}
	const field = probe === "cold-start" ? "elapsedMs" : "bytesPerFixture"
	const legacy = summarize(collected.legacy, field)
	const candidate = summarize(collected.candidate, field)
	const limit = probe === "cold-start" ? { p50: legacy.p50 * 1.05, p95: legacy.p95 * 1.1 } : { p95: legacy.p95 * 1.2 }
	const passed = probe === "cold-start" ? candidate.p50 <= limit.p50 && candidate.p95 <= limit.p95 : candidate.p95 <= limit.p95
	report.metrics[probe] = {
		unit: probe === "cold-start" ? "milliseconds" : "bytes_per_fixture",
		legacy,
		candidate,
		limit,
		passed,
	}
	console.log(`WS-051 ${probe} ${JSON.stringify(report.metrics[probe])}`)
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
	if (!passed) process.exitCode = 1
}

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
console.log(`WS-051 performance report written to ${output}`)
