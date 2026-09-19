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

	it("packages dev tags as preview and production tags as production", async () => {
		const previewWorkflow = await readProjectFile(".github/workflows/release-draft.yml")
		const productionWorkflow = await readProjectFile(".github/workflows/release.yml")

		expect(previewWorkflow).toContain("package_channel: preview")
		expect(previewWorkflow).toContain('.name == "dline-preview"')
		expect(previewWorkflow).toContain("(.preview == true)")
		expect(productionWorkflow).toContain("package_channel: production")
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
		expect(registryWorkflow).toContain("DLINE_VSCODE_RELEASE_PUBLISH_PAT")
		expect(registryWorkflow).toContain("DLINE_VSCODE_OVSX_PAT")
		expect(registryWorkflow).toContain("@vscode/vsce@3.9.2")
		expect(registryWorkflow).toContain("ovsx@1.2.0")
		expect(registryWorkflow.match(/EXPECTED_SHA256: \$\{\{ inputs\.expected_sha256 \}\}/g)).toHaveLength(2)
		expect(registryWorkflow.match(/name: \$\{\{ inputs\.artifact_name \}\}/g)).toHaveLength(2)
		expect(productionWorkflow).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
	})
})
