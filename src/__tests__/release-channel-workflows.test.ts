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
			".github/workflows/publish-production-release.yml",
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

	it("routes every package through the shared cross-platform VSCE API worker", async () => {
		const packageWorkflow = await readProjectFile(".github/workflows/package.yml")
		const packageScript = await readProjectFile("scripts/package-vsix.mjs")
		const packageDevScript = await readProjectFile("scripts/package-dev.mjs")
		const packageAdapter = await readProjectFile("scripts/vsix-packager.mjs")

		expect(packageWorkflow).toContain('node scripts/package-vsix.mjs --channel "$CHANNEL" --out')
		expect(packageWorkflow).toContain("node scripts/package-vsix.mjs --channel production --out")
		expect(packageWorkflow).toContain("source_ref:")
		expect(packageWorkflow).toContain("artifact_key:")
		expect(packageWorkflow).toContain("commit_sha:")
		expect(packageWorkflow).toContain("sha256:")
		expect(packageScript).toContain('mode: "build-and-pack"')
		expect(packageDevScript).toContain('mode: "pack-only"')
		expect(packageAdapter).toContain("execFileSync(process.execPath")
		expect(packageAdapter).toContain("await createVSIX(packageOptions)")
		expect(packageAdapter).toContain("await packVSIX(packageOptions)")
		expect(packageAdapter).toMatch(/dependencies:\s*false/)
		expect(`${packageWorkflow}\n${packageScript}\n${packageDevScript}`).not.toContain("npx.cmd")
	})

	it("publishes dev tags as public Preview prereleases and fully validated production tags automatically", async () => {
		const previewWorkflow = await readProjectFile(".github/workflows/release-draft.yml")
		const productionWorkflow = await readProjectFile(".github/workflows/release.yml")

		expect(previewWorkflow).toContain("name: Publish Preview Release")
		expect(previewWorkflow).toContain("package_channel: preview")
		expect(previewWorkflow).toContain('expected_asset_name="dline-preview-${VERSION}.vsix"')
		expect(previewWorkflow).toContain('.name == "dline-preview"')
		expect(previewWorkflow).toContain("(.preview == true)")
		expect(previewWorkflow).toContain("--draft=false")
		expect(previewWorkflow).toContain("--prerelease")

		expect(productionWorkflow).toContain("name: Production Release Validation")
		expect(productionWorkflow).toContain("group: production-release-${{ github.ref_name }}")
		expect(productionWorkflow).toContain('main_sha=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main"')
		expect(productionWorkflow).toContain('if [[ "$tag_sha" != "$main_sha" ]]; then')
		expect(productionWorkflow).toContain("package_channel: production")
		expect(productionWorkflow).toContain('DLINE_E2E_INSTALL_VSIX: "1"')
		expect(productionWorkflow).toContain('cp "${assets[0]}" dist/e2e.vsix')
		expect(productionWorkflow).toContain("playwright.functional.config.ts")
		expect(productionWorkflow).toContain("Automatically publish validated production release")
		expect(productionWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
		expect(productionWorkflow).toContain("artifact_name: dline-vsix-${{ needs.verify-tag.outputs.commit_sha }}")
	})

	it("lets a manager publish a freshly built production VSIX without depending on validation results", async () => {
		const manualWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")

		expect(manualWorkflow).toContain("name: Production Release (Manual Override)")
		expect(manualWorkflow).toContain("workflow_dispatch:")
		expect(manualWorkflow).toContain("group: production-release-${{ inputs.tag }}")
		expect(manualWorkflow).toContain("reason:")
		expect(manualWorkflow).toContain("Build fresh production VSIX")
		expect(manualWorkflow).toContain("source_ref: ${{ needs.validate.outputs.tag }}")
		expect(manualWorkflow).toContain("artifact_key: ${{ needs.validate.outputs.commit_sha }}")
		expect(manualWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
		expect(manualWorkflow).not.toContain("actions/workflows/release.yml/runs")
		expect(manualWorkflow).not.toContain("no successful Production Release Validation run exists")
	})

	it("publishes only the successful current dev artifact as a per-commit Insiders draft and to registries", async () => {
		const insidersWorkflow = await readProjectFile(".github/workflows/publish-insiders.yml")

		expect(insidersWorkflow).toContain("github.event.workflow_run.conclusion == 'success'")
		expect(insidersWorkflow).toContain("github.event.workflow_run.head_branch == 'dev'")
		expect(insidersWorkflow).toContain('current_dev_sha=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/dev"')
		expect(insidersWorkflow).toContain('.name == "dline-insiders"')
		expect(insidersWorkflow).toContain('echo "release_tag=insiders-$TESTED_SHA"')
		expect(insidersWorkflow).toContain("Publish per-commit Insiders draft")
		expect(insidersWorkflow).toContain('--target "$COMMIT_SHA"')
		expect(insidersWorkflow).toContain("--draft")
		expect(insidersWorkflow).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")
	})

	it("funnels both production paths through one idempotent GitHub and registry publisher", async () => {
		const automaticWorkflow = await readProjectFile(".github/workflows/release.yml")
		const manualWorkflow = await readProjectFile(".github/workflows/publish-vscode-marketplace.yml")
		const productionPublisher = await readProjectFile(".github/workflows/publish-production-release.yml")
		const registryWorkflow = await readProjectFile(".github/workflows/publish-vsix-registries.yml")

		expect(automaticWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
		expect(manualWorkflow).toContain("uses: ./.github/workflows/publish-production-release.yml")
		expect(productionPublisher).toContain("gh release edit")
		expect(productionPublisher).toContain("gh release create")
		expect(productionPublisher).toContain('gh release upload "$TAG" "$VSIX_PATH" --clobber')
		expect(productionPublisher).toContain("uses: ./.github/workflows/publish-vsix-registries.yml")

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
	})

	it("tolerates one failing registry and fails the stage only when neither accepted the release", async () => {
		const registryWorkflow = (await readProjectFile(".github/workflows/publish-vsix-registries.yml")) as string
		const parsed = load(registryWorkflow) as {
			jobs: Record<string, { "continue-on-error"?: boolean; outputs?: Record<string, string>; needs?: string[] }>
		}

		// Each registry absorbs its own failure, so one outage cannot withhold the
		// release from the registry that is still reachable.
		for (const jobName of ["publish-marketplace", "publish-open-vsx"]) {
			const job = parsed.jobs[jobName]
			expect(job?.["continue-on-error"], `${jobName} must not fail the stage by itself`).toBe(true)
			expect(job?.outputs?.status, `${jobName} must report its outcome`).toBe("${{ steps.publish.outputs.status }}")
		}

		// The aggregate gate is the only place that decides the stage conclusion,
		// and it must still run when a publish job failed.
		const gate = parsed.jobs["require-one-registry"]
		expect(gate?.needs).toEqual(["publish-marketplace", "publish-open-vsx"])
		expect(registryWorkflow).toContain("if: always() && github.repository == 'TuvokYang/dline'")
		expect(registryWorkflow).toContain('if [[ "${#published[@]}" -eq 0 ]]; then')

		// An aborted job reports nothing, which must count as that registry
		// failing rather than as a silent success.
		expect(registryWorkflow).toContain('"marketplace=${MARKETPLACE_STATUS:-unreported}"')
		expect(registryWorkflow).toContain('"open-vsx=${OPEN_VSX_STATUS:-unreported}"')
		expect(registryWorkflow.match(/echo "status=published" >> "\$GITHUB_OUTPUT"/g)).toHaveLength(2)
		expect(registryWorkflow.match(/echo "status=failed" >> "\$GITHUB_OUTPUT"/g)).toHaveLength(2)
	})
})
