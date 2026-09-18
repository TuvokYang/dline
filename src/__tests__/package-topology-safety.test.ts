import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

interface RootPackageJson {
	name: string
	workspaces?: string[] | string
	scripts?: Record<string, string>
}

interface RootPackageLock {
	packages?: Record<string, { link?: boolean; workspaces?: string[] }>
}

const PROJECT_ROOT = process.cwd()

async function readProjectFile(relativePath: string): Promise<string> {
	return fs.readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
}

function normalizeWorkspace(workspace: string): string {
	const normalized = workspace.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
	return normalized || "."
}

function expectDirectVsceCommandsToDisableDependencyScanning(source: string, sourceName: string): void {
	const commands = source.split(/\r?\n/).filter((line) => {
		const trimmed = line.trimStart()
		return (
			/\bvsce\s+package\b/.test(line) && !trimmed.startsWith("#") && !trimmed.startsWith("//") && !trimmed.startsWith("*")
		)
	})

	for (const command of commands) {
		expect(command, `${sourceName} must disable VSIX dependency scanning`).toContain("--no-dependencies")
	}
}

describe("package topology safety", () => {
	it("does not declare the root package as its own npm workspace", async () => {
		const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
		const workspaces = Array.isArray(packageJson.workspaces)
			? packageJson.workspaces
			: packageJson.workspaces
				? [packageJson.workspaces]
				: []

		expect(workspaces.map(normalizeWorkspace)).not.toContain(".")

		const packageLock = JSON.parse(await readProjectFile("package-lock.json")) as RootPackageLock
		expect(packageLock.packages?.[""]?.workspaces?.map(normalizeWorkspace) ?? []).not.toContain(".")
		const selfLink = packageLock.packages?.[`node_modules/${packageJson.name}`]
		expect(
			selfLink?.link,
			`package-lock.json must not link node_modules/${packageJson.name} to the repository root`,
		).not.toBe(true)
	})

	it("skips duplicate Marketplace versions across release workflow reruns", async () => {
		const marketplaceWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")

		expect(marketplaceWorkflow).toContain("group: vscode-marketplace-${{ github.event.workflow_run.head_sha }}")
		expect(marketplaceWorkflow).toContain('"$VSCE_BIN" publish --skip-duplicate --packagePath "$vsix_path"')
	})

	it("disables dependency scanning in every extension packaging entry point", async () => {
		const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
		expect(packageJson.scripts?.["test:e2e:build"]).toContain("--no-dependencies")

		const packageDev = await readProjectFile("scripts/package-dev.mjs")
		expect(packageDev).toMatch(/dependencies:\s*false/)

		const packageVsix = await readProjectFile("scripts/package-vsix.mjs")
		expectDirectVsceCommandsToDisableDependencyScanning(packageVsix, "scripts/package-vsix.mjs")

		const publishNightly = await readProjectFile("scripts/publish-nightly.mjs")
		expect(publishNightly).toContain('"--no-dependencies"')
		expect(publishNightly).not.toMatch(/WorkspaceSelfLink|workspace self-link/i)

		const publishMarketplace = await readProjectFile("scripts/publish-marketplace.mjs")
		expect(publishMarketplace).toContain('"--no-dependencies"')

		const workflowNames = (await fs.readdir(path.join(PROJECT_ROOT, ".github", "workflows")))
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.sort()
		for (const workflowName of workflowNames) {
			const workflowPath = `.github/workflows/${workflowName}`
			expectDirectVsceCommandsToDisableDependencyScanning(await readProjectFile(workflowPath), workflowPath)
		}
	})
})
