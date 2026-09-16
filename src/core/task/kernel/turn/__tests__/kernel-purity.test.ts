import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const KERNEL_DIR = path.resolve(__dirname, "..")

/** Kernel source files, excluding this suite's own directory. */
function kernelSourceFiles(): string[] {
	return readdirSync(KERNEL_DIR)
		.filter((entry) => entry.endsWith(".ts"))
		.map((entry) => path.join(KERNEL_DIR, entry))
}

/**
 * Strip comments so prose cannot be mistaken for code.
 *
 * Without this, an ordinary English sentence in a doc comment that happens to
 * contain `from "..."` is reported as an import, and the purity check fails on
 * the documentation rather than on a dependency.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/**
 * Module specifiers a file imports, in every form the language offers.
 *
 * Matching only `from "..."` at end of line would miss a side-effect import, a
 * dynamic `import()`, a `require()`, and anything followed by a semicolon. A
 * scan that a forbidden import can walk past is worse than no scan, because it
 * reports success.
 */
function scanSource(source: string): string[] {
	const stripped = stripComments(source)
	const specifiers: string[] = []
	const patterns = [
		// import ... from "x"  /  export ... from "x"
		/\bfrom\s*["']([^"']+)["']/g,
		// import "x"  (side effect)
		/\bimport\s+["']([^"']+)["']/g,
		// import("x")  /  await import("x")
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		// require("x")
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	]
	for (const pattern of patterns) {
		for (const match of stripped.matchAll(pattern)) {
			specifiers.push(match[1])
		}
	}
	return specifiers
}

function importSpecifiers(filePath: string): string[] {
	return scanSource(readFileSync(filePath, "utf8"))
}

/**
 * Whether a relative specifier stays inside the kernel directory.
 *
 * `./` is not by itself evidence of a sibling: `./../../runtime/x` is relative
 * and still escapes. Resolving the path is the only honest test.
 */
function isSiblingKernelModule(specifier: string, fromFile: string): boolean {
	if (!specifier.startsWith(".")) return false
	const resolved = path.resolve(path.dirname(fromFile), specifier)
	const relative = path.relative(KERNEL_DIR, resolved)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Import prefixes that would make a kernel module impure.
 *
 * The kernel exists so scheduling and approval decisions can be exercised
 * without constructing a Task. An import from any of these reintroduces the
 * dependency the split was meant to remove, and it does so silently: the code
 * still compiles and the tests still pass, only slower and less isolated.
 */
const FORBIDDEN_PREFIXES = [
	"../runtime",
	"../../runtime",
	"../executors",
	"../../executors",
	"../tools",
	"../../tools",
	"@core/task/runtime",
	"@core/storage",
	"@hosts/",
	"@/hosts/",
	"vscode",
	"node:fs",
	"node:child_process",
	"node:http",
	"node:https",
	"node:net",
	"fs",
	"child_process",
]

/** Import specifiers the kernel is allowed to depend on. */
const ALLOWED_EXACT = new Set(["@shared/tools", "@shared/AutoApprovalSettings"])

describe("kernel purity", () => {
	it("finds the kernel modules", () => {
		// Without this the loop below would pass vacuously if the directory
		// were renamed or the files moved.
		expect(kernelSourceFiles().length).toBeGreaterThanOrEqual(3)
	})

	it("detects the imports the kernel actually declares", () => {
		// Guards the scanner: a regex that matched nothing would make every
		// assertion below pass without reading a single import.
		const approvalKind = path.join(KERNEL_DIR, "approval-kind.ts")
		expect(importSpecifiers(approvalKind)).toContain("@shared/tools")
	})

	it("recognises every import form a forbidden dependency could use", () => {
		// The scanner is the thing being trusted, so it is exercised against
		// each form directly rather than only against today's clean source.
		const sample = [
			`import { a } from "../../runtime/one";`,
			`import "../../runtime/two"`,
			`const c = await import("../../runtime/three")`,
			`const d = require("../../runtime/four")`,
			`export { e } from "../../runtime/five"`,
		].join("\n")

		const scanned = scanSource(sample)

		expect(scanned).toEqual(
			expect.arrayContaining([
				"../../runtime/one",
				"../../runtime/two",
				"../../runtime/three",
				"../../runtime/four",
				"../../runtime/five",
			]),
		)
	})

	it("treats a relative specifier that escapes the kernel as external", () => {
		const insideKernel = path.join(KERNEL_DIR, "tool-lanes.ts")

		expect(isSiblingKernelModule("./pool-admission", insideKernel)).toBe(true)
		// Relative, but it leaves the directory; accepting it on the "./"
		// prefix alone is how a runtime import would slip past the check.
		expect(isSiblingKernelModule("./../../runtime/TaskRuntime", insideKernel)).toBe(false)
		expect(isSiblingKernelModule("../../runtime/TaskRuntime", insideKernel)).toBe(false)
	})

	it("imports no runtime, executor, host, storage or IO module", () => {
		const violations: Array<{ file: string; specifier: string }> = []

		for (const file of kernelSourceFiles()) {
			for (const specifier of importSpecifiers(file)) {
				if (ALLOWED_EXACT.has(specifier)) continue
				// A sibling kernel module is fine; the kernel may be layered.
				if (isSiblingKernelModule(specifier, file)) continue

				if (FORBIDDEN_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
					violations.push({ file: path.basename(file), specifier })
				}
			}
		}

		expect(violations).toEqual([])
	})

	it("declares every non-relative import as shared identity or types", () => {
		const unexpected: Array<{ file: string; specifier: string }> = []

		for (const file of kernelSourceFiles()) {
			for (const specifier of importSpecifiers(file)) {
				if (isSiblingKernelModule(specifier, file)) continue
				if (ALLOWED_EXACT.has(specifier)) continue
				unexpected.push({ file: path.basename(file), specifier })
			}
		}

		// Failing here is not automatically a defect; it means a new dependency
		// was added and its purity has to be judged rather than assumed.
		expect(unexpected).toEqual([])
	})

	it("exercises the kernel without constructing a Task", async () => {
		const { resolveToolLanes } = await import("../tool-lanes")
		const { decideAdmission } = await import("../pool-admission")
		const { resolveApprovalKind } = await import("../approval-kind")
		const { DEFAULT_AUTO_APPROVAL_SETTINGS } = await import("@shared/AutoApprovalSettings")
		const { ClineDefaultTool } = await import("@shared/tools")

		const lanes = resolveToolLanes(ClineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/a.ts"] })
		const admission = decideAdmission({
			pending: [{ dlineTid: "a", index: 0, lanes, isTurnEnding: false }],
			running: [],
			limit: 2,
		})
		const approval = resolveApprovalKind({
			toolName: ClineDefaultTool.FILE_EDIT,
			settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
		})

		expect(admission.admit).toHaveLength(1)
		expect(approval.scope).toBe("edit_workspace")
	})
})
