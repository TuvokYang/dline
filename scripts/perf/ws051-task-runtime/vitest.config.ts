import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

const harnessRoot = process.env.WS051_HARNESS_ROOT
const targetRoot = process.env.WS051_TARGET_ROOT
const variant = process.env.WS051_VARIANT
const probe = process.env.WS051_PROBE

if (!harnessRoot || !targetRoot || (variant !== "candidate" && variant !== "legacy")) {
    throw new Error("WS051 harness root, target root, and variant are required")
}
if (probe !== "cold-start" && probe !== "prompt-context" && probe !== "retained-heap") {
    throw new Error(`Unsupported WS051 probe: ${probe ?? "missing"}`)
}

const retainedFixture = variant === "candidate" ? "retained-candidate.fixture.ts" : "retained-legacy.fixture.ts"

export default defineConfig({
    cacheDir: resolve(harnessRoot, "tmp/ws051-runtime-performance/vite-cache", variant, probe),
    resolve: {
        alias: {
            "@perf/task-entry": resolve(targetRoot, "src/core/task/index.ts"),
            "@perf/prompt-context-entry": resolve(
                targetRoot,
                variant === "candidate" ? "src/core/task/prompt/TaskPromptContextOwner.ts" : "src/core/task/index.ts",
            ),
            "@perf/retained-fixture": resolve(__dirname, retainedFixture),
            "@perf/kernel": resolve(targetRoot, "src/core/task/kernel/index.ts"),
            "@perf/candidate-runtime": resolve(targetRoot, "src/core/task/runtime/TaskRuntime.ts"),
            "@perf/candidate-stores": resolve(targetRoot, "src/core/task/stores/InMemoryRuntimeStores.ts"),
            "@perf/legacy-runtime": resolve(targetRoot, "src/core/task/runtime/TaskRuntime.ts"),
            "@perf/legacy-snapshot": resolve(targetRoot, "src/core/task/TaskSnapshot.ts"),
            "@perf/legacy-block-phase": resolve(targetRoot, "src/core/task/BlockPhaseMachine.ts"),
            "@perf/legacy-task-phase": resolve(targetRoot, "src/core/task/TaskPhase.ts"),
            "@perf/legacy-task-state": resolve(targetRoot, "src/core/task/TaskState.ts"),
            vscode: resolve(targetRoot, "src/test/vscode-mock.ts"),
            "@": resolve(targetRoot, "src"),
            "@api": resolve(targetRoot, "src/core/api"),
            "@core": resolve(targetRoot, "src/core"),
            "@generated": resolve(targetRoot, "src/generated"),
            "@hosts": resolve(targetRoot, "src/hosts"),
            "@integrations": resolve(targetRoot, "src/integrations"),
            "@packages": resolve(targetRoot, "src/packages"),
            "@services": resolve(targetRoot, "src/services"),
            "@shared": resolve(targetRoot, "src/shared"),
            "@utils": resolve(targetRoot, "src/utils"),
        },
    },
    test: {
        include: [`scripts/perf/ws051-task-runtime/${probe}.probe.test.ts`],
        setupFiles: [],
        globals: false,
        environment: "node",
        pool: "forks",
        execArgv: ["--expose-gc"],
        maxWorkers: 1,
        minWorkers: 1,
        fileParallelism: false,
        isolate: true,
        testTimeout: 60_000,
    },
})
