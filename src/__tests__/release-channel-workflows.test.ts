import fs from "node:fs/promises"
import path from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

const PROJECT_ROOT = process.cwd()

async function readProjectFile(relativePath: string): Promise<string> {
	return fs.readFile(path.join(PROJECT_ROOT, relativePath), "utf8")
}

describe("release channel workflows", () => {
	it("keeps every changed workflow parseable as YAML", async () => {
		for (const workflowPath of [
			".github/workflows/test.yml",
			".github/workflows/package.yml",
			".github/workflows/release.yml",
			".github/workflows/release-draft.yml",
			".github/workflows/publish-vscode-marketplace.yml",
			".github/workflows/publish-insiders.yml",
			".github/workflows/publish-vsix-registries.yml",
		]) {
			expect(load(await readProjectFile(workflowPath)), workflowPath).toBeTypeOf("object")
		}
	})

	it("maps a direct dev push to the Insiders channel without changing pull-request packages", async () => {
		const testsWorkflow = await readProjectFile(".github/workflows/test.yml")

		expect(testsWorkflow).toContain('"$EVENT_NAME" == "push" && "$REF_NAME" == "refs/heads/dev"')
		expect(testsWorkflow).toContain('channel="insiders"')
		expect(testsWorkflow).toContain('channel="ci"')
		expect(testsWorkflow).toContain("channel: ${{ needs.typecheck.outputs.package_channel }}")
	})

	it("routes every workflow package through the channel-aware VSIX entry point", async () => {
		const packageWorkflow = await readProjectFile(".github/workflows/package.yml")
		const packageScript = await readProjectFile("scripts/package-vsix.mjs")

		expect(packageWorkflow).toContain('node scripts/package-vsix.mjs --channel "$CHANNEL" --out')
		expect(packageWorkflow).toContain("node scripts/package-vsix.mjs --channel production --out")
		expect(packageWorkflow).not.toContain("npm exec -- vsce package")
		expect(packageScript).toContain('["auto", "ci", "production", "preview", "insiders"]')
		expect(packageScript).toContain('argument === "--channel"')
		expect(packageScript).toContain('argument === "--out"')
	})

	it("packages dev tags as preview and validates production tags without publishing them", async () => {
		const previewWorkflow = await readProjectFile(".github/workflows/release-draft.yml")
		const validationWorkflow = await readProjectFile(".github/workflows/release.yml")

		expect(previewWorkflow).toContain("package_channel: preview")
		expect(previewWorkflow).toContain('.name == "dline-preview"')
		expect(previewWorkflow).toContain("(.preview == true)")
		expect(validationWorkflow).toContain("name: Production Release Validation")
		expect(validationWorkflow).toContain("git fetch origin main --no-tags")
		expect(validationWorkflow).toContain("main_sha=$(git rev-parse origin/main)")
		expect(validationWorkflow).toContain('if [[ "$tag_sha" != "$main_sha" ]]; then')
		expect(validationWorkflow).toContain("must point to current main head")
		expect(validationWorkflow).toContain("package_channel: production")
		expect(validationWorkflow).toContain('DLINE_E2E_INSTALL_VSIX: "1"')
		expect(validationWorkflow).toContain('cp "${assets[0]}" dist/e2e.vsix')
		expect(validationWorkflow).toContain("playwright.functional.config.ts")
		expect(validationWorkflow).not.toContain("gh release create")
	})

	it("requires a successful validation before a manager manually publishes production", async () => {
		const productionWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")

		expect(productionWorkflow).toContain("workflow_dispatch:")
		expect(productionWorkflow.match(/if: github\.repository == 'TuvokYang\/dline'/g)).toHaveLength(2)
		expect(productionWorkflow).toContain("tag:")
		expect(productionWorkflow).toContain("actions/workflows/release.yml/runs?event=push&status=success")
		expect(productionWorkflow).toContain("no successful Production Release Validation run exists")
		expect(productionWorkflow).toContain("gh release create")
		expect(productionWorkflow).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
	})

	it("publishes only a successful current dev artifact as Insiders", async () => {
		const insidersWorkflow = await readProjectFile(".github/workflows/publish-insiders.yml")

		expect(insidersWorkflow).toContain("github.event.workflow_run.conclusion == 'success'")
		expect(insidersWorkflow).toContain("github.event.workflow_run.head_branch == 'dev'")
		expect(insidersWorkflow).toContain('current_dev_sha=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/dev"')
		expect(insidersWorkflow).toContain('.name == "dline-insiders"')
		expect(insidersWorkflow).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
	})

	it("publishes the same verified VSIX to Marketplace and Open VSX", async () => {
		const registryWorkflow = await readProjectFile(".github/workflows/publish-vsix-registries.yml")
		const productionWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")

		expect(registryWorkflow.match(/name: dline-release/g)).toHaveLength(2)
		expect(registryWorkflow.match(/if: github\.repository == 'TuvokYang\/dline'/g)).toHaveLength(2)
		expect(registryWorkflow).toContain("DLINE_VSCODE_RELEASE_PUBLISH_PAT")
		expect(registryWorkflow).toContain("DLINE_VSCODE_OVSX_PAT")
		expect(registryWorkflow).toContain("@vscode/vsce@3.9.2")
		expect(registryWorkflow).toContain("ovsx@1.2.0")
		expect(registryWorkflow).toContain("for attempt in 1 2 3")
		expect(registryWorkflow).toContain("RequestBlockedException|Concurrency")
		const ovsxInstall = registryWorkflow.slice(registryWorkflow.indexOf("Install pinned Open VSX CLI"))
		expect(ovsxInstall).toContain("--include=optional")
		expect(ovsxInstall).not.toContain("--omit=optional")
		expect(registryWorkflow.match(/EXPECTED_SHA256: \$\{\{ inputs\.expected_sha256 \}\}/g)).toHaveLength(2)
		expect(registryWorkflow.match(/name: \$\{\{ inputs\.artifact_name \}\}/g)).toHaveLength(2)
		expect(productionWorkflow).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
	})
})
