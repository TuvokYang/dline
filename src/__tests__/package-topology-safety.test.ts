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

	it("publishes one verified production artifact idempotently through either serialized path", async () => {
		const automaticWorkflow = await readProjectFile(".github/workflows/release.yml")
		const manualWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")
		const productionPublisher = await readProjectFile(".github/workflows/publish-production-release.yml")
		const registryWorkflow = await readProjectFile(".github/workflows/publish-vsix-registries.yml")

		expect(automaticWorkflow).toContain("group: production-release-${{ github.ref_name }}")
		expect(manualWorkflow).toContain("group: production-release-${{ inputs.tag }}")
		expect(automaticWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
		expect(manualWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
		expect(productionPublisher).toContain('gh release upload "$TAG" "$VSIX_PATH" --clobber')
		expect(productionPublisher).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
		expect(registryWorkflow).toContain('"$VSCE_BIN" publish --skip-duplicate --packagePath "$vsix_path"')
		expect(registryWorkflow).toContain('"$OVSX_BIN" publish "$vsix_path" --skip-duplicate')
		expect(registryWorkflow.match(/name: \$\{\{ inputs\.artifact_name \}\}/g)).toHaveLength(2)
	})

	it("serializes builds against concurrent runs of the shared dist output", async () => {
		const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
		const scripts = packageJson.scripts ?? {}

		// dist/ is the one piece of E2E state that is not run-scoped, so every
		// script that writes it must take the exclusive side and every script that
		// reads it must take the shared side.
		expect(scripts["pree2e"]).toContain("--exclusive")
		expect(scripts["test:e2e:build"]).toContain("--exclusive")
		for (const scriptName of [
			"e2e",
			"e2e:smoke",
			"e2e:work",
			"e2e:functional",
			"e2e:dev",
			"e2e:pressure",
			"e2e:demo",
			"e2e:legacy",
		]) {
			expect(scripts[scriptName], `${scriptName} must take the shared dist lock`).toContain("--shared")
		}

		// A packaged tier must not also rebuild through pree2e; the VSIX build and
		// the bundle build would each claim dist/ and deadlock the other.
		for (const scriptName of ["test:e2e", "test:e2e:optimal", "test:e2e:pressure"]) {
			expect(scripts[scriptName], `${scriptName} must build the VSIX once`).toContain("npm run test:e2e:build")
			expect(scripts[scriptName], `${scriptName} must not chain a tier rebuild`).not.toMatch(
				/npm run e2e:(work|functional)\b/,
			)
		}

		// Source-mode tiers intentionally reuse the pree2e bundle instead of
		// packaging a VSIX that their fixture would never install.
		for (const scriptName of ["test:e2e:work", "test:e2e:functional"]) {
			expect(scripts[scriptName], `${scriptName} must not package an unused VSIX`).not.toContain("test:e2e:build")
			expect(scripts[scriptName]).toContain("npm run e2e:prepare")
		}

		const lockRunner = await readProjectFile("scripts/with-dist-lock.mjs")
		expect(lockRunner).toContain("acquireDistLock")

		// The lock lives inside dist/, which vsce packages verbatim.
		expect(await readProjectFile(".vscodeignore")).toContain("dist/.e2e-lock/")
	})

	it("disables dependency scanning in every extension packaging entry point", async () => {
		const packageJson = JSON.parse(await readProjectFile("package.json")) as RootPackageJson
		expect(packageJson.scripts?.["test:e2e:build"]).toContain("--no-dependencies")

		const packageDev = await readProjectFile("scripts/package-dev.mjs")
		const packageVsix = await readProjectFile("scripts/package-vsix.mjs")
		const packageAdapter = await readProjectFile("scripts/vsix-packager.mjs")
		expect(packageDev).toContain('mode: "pack-only"')
		expect(packageVsix).toContain('mode: "build-and-pack"')
		expect(packageAdapter).toMatch(/dependencies:\s*false/)
		expect(packageAdapter).toContain("execFileSync(process.execPath")
		expectDirectVsceCommandsToDisableDependencyScanning(packageVsix, "scripts/package-vsix.mjs")

		const publishInsiders = await readProjectFile("scripts/publish-insiders.mjs")
		expect(publishInsiders).toContain('"--no-dependencies"')
		expect(publishInsiders).not.toMatch(/WorkspaceSelfLink|workspace self-link/i)

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
