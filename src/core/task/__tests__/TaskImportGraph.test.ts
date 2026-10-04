import path from "node:path"
import { describe, expect, it } from "vitest"
import { edgeKey, type ImportEdge, isUnder, scanImportGraph } from "./architecture/import-graph"

const REPO = path.resolve(__dirname, "../../../..")
const TASK_ROOT = path.join(REPO, "src/core/task")
const KERNEL_ROOT = path.join(TASK_ROOT, "kernel")
const KERNEL_PUBLIC = "src/core/task/kernel/index.ts"
const EXECUTORS_ROOT = path.join(TASK_ROOT, "executors")
const RUNTIME_ROOT = path.join(TASK_ROOT, "runtime")
const SUBRUNTIME_ROOT = path.join(TASK_ROOT, "subruntime")
const RESOURCES_ROOT = path.join(TASK_ROOT, "resources")
const VIEW_ROOT = path.join(TASK_ROOT, "view")
const SHELL_ROOT = path.join(TASK_ROOT, "shell")
const TASK_INDEX = "src/core/task/index.ts"
const STORE_CONTRACT = "src/core/task/stores/contracts.ts"

const TASK_EDGES = scanImportGraph({
	repoRoot: REPO,
	tsconfigPath: path.join(REPO, "tsconfig.json"),
	roots: [TASK_ROOT],
})
const GLOBAL_EDGES = scanImportGraph({
	repoRoot: REPO,
	tsconfigPath: path.join(REPO, "tsconfig.json"),
	roots: [path.join(REPO, "src"), path.join(REPO, "webview-ui/src")],
})

const EXECUTOR_DOMAINS = new Set([
	"background",
	"compaction",
	"compose",
	"cotask",
	"dialog",
	"halt",
	"policy",
	"provider",
	"spawn",
	"tool",
])

function workspaceTarget(edge: ImportEdge): string | undefined {
	return edge.target.kind === "workspace" ? edge.target.path : undefined
}

function executorDomain(file: string): string | undefined {
	const match = /^src\/core\/task\/executors\/([^/]+)\//.exec(file)
	return match && EXECUTOR_DOMAINS.has(match[1]) ? match[1] : undefined
}

describe("WS-051 shared-contract import graph", () => {
	it("keeps kernel production dependencies inside kernel", () => {
		const violations = TASK_EDGES.filter((edge) => isUnder(edge.importerAbsolute, KERNEL_ROOT))
			.filter((edge) => edge.target.kind !== "workspace" || !isUnder(edge.target.absolute, KERNEL_ROOT))
			.map(edgeKey)
		expect(violations).toEqual([])
	})

	it("keeps executor domains isolated and on the kernel public entry", () => {
		const violations = TASK_EDGES.flatMap((edge) => {
			const sourceDomain = executorDomain(edge.importer)
			if (!sourceDomain) return []
			const target = workspaceTarget(edge)
			if (!target) return []
			const targetDomain = executorDomain(target)
			if (targetDomain && targetDomain !== sourceDomain) return [edgeKey(edge)]
			if (target.startsWith("src/core/task/executors/")) {
				if (target.startsWith(`src/core/task/executors/${sourceDomain}/`)) return []
				if (target.startsWith("src/core/task/executors/shared/")) return []
				if (target === "src/core/task/executors/contracts.ts") return []
				if (target.startsWith("src/core/task/executors/inbound/")) return [edgeKey(edge)]
			}
			if (target.startsWith("src/core/task/kernel/") && target !== KERNEL_PUBLIC) return [edgeKey(edge)]
			if (
				target.startsWith("src/core/task/shell/") ||
				target.startsWith("src/core/controller/") ||
				target === "src/core/task/TaskStateManager.ts" ||
				target === TASK_INDEX
			) {
				return [edgeKey(edge)]
			}
			return []
		})
		expect(violations).toEqual([])
	})

	it("keeps runtime on kernel public API and store/view contracts", () => {
		const violations = TASK_EDGES.filter((edge) => isUnder(edge.importerAbsolute, RUNTIME_ROOT)).flatMap((edge) => {
			const target = workspaceTarget(edge)
			if (!target) return [edgeKey(edge)]
			if (target.startsWith("src/core/task/runtime/")) return []
			if (target === KERNEL_PUBLIC || target === STORE_CONTRACT) return []
			return [edgeKey(edge)]
		})
		expect(violations).toEqual([])
	})

	it("keeps subruntime on public types, resources, and injected shell ports", () => {
		const violations = TASK_EDGES.filter((edge) => isUnder(edge.importerAbsolute, SUBRUNTIME_ROOT)).flatMap((edge) => {
			const target = workspaceTarget(edge)
			if (!target) return [edgeKey(edge)]
			if (target.startsWith("src/core/task/subruntime/")) return []
			if (target === KERNEL_PUBLIC && edge.typeOnly) return []
			if (target === "src/core/task/resources/index.ts") return []
			if (target.startsWith("src/core/task/shell/") && edge.typeOnly) return []
			return [edgeKey(edge)]
		})
		expect(violations).toEqual([])
	})

	it("keeps resources independent from executors and subruntime", () => {
		const violations = TASK_EDGES.filter((edge) => isUnder(edge.importerAbsolute, RESOURCES_ROOT))
			.filter((edge) => {
				const target = workspaceTarget(edge)
				return target?.startsWith("src/core/task/executors/") || target?.startsWith("src/core/task/subruntime/")
			})
			.map(edgeKey)
		expect(violations).toEqual([])
	})

	it("keeps views read-only from executors and shell", () => {
		const violations = TASK_EDGES.filter((edge) => isUnder(edge.importerAbsolute, VIEW_ROOT))
			.filter((edge) => {
				const target = workspaceTarget(edge)
				return (
					target?.startsWith("src/core/task/executors/") ||
					isUnder(edge.target.kind === "workspace" ? edge.target.absolute : "", SHELL_ROOT)
				)
			})
			.map(edgeKey)
		expect(violations).toEqual([])
	})

	it("keeps the task barrel out of all internal production modules", () => {
		const violations = GLOBAL_EDGES.filter(
			(edge) => edge.target.kind === "workspace" && edge.target.path === TASK_INDEX && edge.importer !== TASK_INDEX,
		).map(edgeKey)
		expect(violations).toEqual([])
	})
})
