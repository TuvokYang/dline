import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const OUTER_PROVIDER_CALLERS = [
    "src/core/task/composition/TaskSessionCompositionService.ts",
    "src/core/task/composition/TaskSessionHostFactory.ts",
    "src/core/task/composition/TaskSessionPorts.ts",
    "src/core/task/session/TaskToolExecutionOwner.ts",
    "src/core/task/tools/types/TaskConfig.ts",
    "src/core/task/tools/subagent/SubagentRunner.ts",
    "src/core/task/ContextCompactionSession.ts",
    "src/core/context/context-management/internal-compaction-pass.ts",
    "src/core/task/executors/provider/service/DefaultProductionProviderService.ts",
] as const

const FORBIDDEN_OUTER_INJECTION_MARKERS = [
    "providerRequestRound",
    "bindAttempt",
    "attachExactUsage",
    "usageSettlement",
    "usageAttempts",
    "RemoteUsageCoordinator",
    "remoteUsageRuntime",
    "NestedUsageSettlement",
] as const

function source(file: string): string {
    return readFileSync(path.resolve(file), "utf8")
}

function providerSources(): readonly { file: string; contents: string }[] {
    const directory = "src/core/api/providers"
    return readdirSync(path.resolve(directory), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => {
            const file = `${directory}/${entry.name}`
            return { file, contents: source(file) }
        })
}

describe("WS-115 unified telemetry architecture gate", () => {
    it("keeps Task, runner, compaction and Provider service callers free of parallel Usage injection", () => {
        for (const file of OUTER_PROVIDER_CALLERS) {
            const contents = source(file)
            for (const marker of FORBIDDEN_OUTER_INJECTION_MARKERS) {
                expect(contents, `${file} must not contain ${marker}`).not.toContain(marker)
            }
        }
    })

    it("keeps ApiHandler as the single Provider abstraction and observation owner", () => {
        const contract = source("src/core/api/ApiHandler.ts")
        const factory = source("src/core/api/index.ts")
        const instrumentation = source("src/core/api/observability/instrument-api-handler.ts")

        expect(contract.match(/export abstract class ApiHandler\b/gu)).toHaveLength(1)
        expect(contract).not.toMatch(/(?:interface|class) BaseApiHandler\b/u)
        expect(contract).not.toMatch(/interface ApiHandler\b/u)
        expect(factory).toContain('export * from "./ApiHandler"')
        expect(factory).toContain("return instrumentApiHandler(withCrossModelHistory(handler), ctx)")
        expect(instrumentation).toContain("ApiHandler.bindProviderAttemptScope")
        expect(instrumentation).toContain("observeExactUsage")
        expect(instrumentation).toContain("providerRequestCompleted")
    })

    it("requires Provider adapters to inherit ApiHandler without importing observer primitives", () => {
        const handlers: string[] = []
        const directAttemptPrimitive =
            /(?<!ApiHandler\.)\b(?:identifyProviderAttempt|observeProviderCall|observeProviderStream|observeProviderStreamResponse|bindProviderAttemptScope)\s*\(/u

        for (const { file, contents } of providerSources()) {
            expect(contents, `${file} must not import provider-attempt-observer`).not.toContain("provider-attempt-observer")
            expect(contents, `${file} must call attempt primitives only through ApiHandler`).not.toMatch(directAttemptPrimitive)

            for (const match of contents.matchAll(/export class (\w+Handler)\s+([^{]+)\{/gu)) {
                handlers.push(`${file}:${match[1]}`)
                expect(match[2], `${file}:${match[1]} must extend ApiHandler`).toMatch(/\bextends ApiHandler\b/u)
            }
        }

        expect(handlers.length).toBeGreaterThan(0)
    })

    it("installs durable Usage only at the process runtime and projects through TaskTurnTelemetry", () => {
        const runtime = source("src/services/telemetry/remote/remoteUsageRuntime.ts")
        const telemetry = source("src/core/task/observability/task-turn-telemetry.ts")
        const accounting = source("src/core/task/observability/task-usage-accounting.ts")

        expect(runtime.match(/installTaskUsageAccountingSink\(/gu)).toHaveLength(1)
        expect(telemetry).toContain("taskUsageAccounting.recordFinalizedAttempt(attempt)")
        expect(accounting).toContain("let activeSink: TaskUsageAccountingSink | undefined")
        for (const file of OUTER_PROVIDER_CALLERS) {
            expect(source(file), `${file} must not install the durable Usage sink`).not.toContain(
                "installTaskUsageAccountingSink",
            )
        }
    })
})
