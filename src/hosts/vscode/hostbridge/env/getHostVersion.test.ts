import { strict as assert } from "assert"
import { afterEach, describe, it, vi } from "vitest"
// sinon import removed
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { ClineClient } from "@/shared/cline"
import { getHostVersion } from "./getHostVersion"

describe("Hostbridge - Env - getHostVersion", () => {
    const sandbox = { mockRestore: () => {} }

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("preserves known remote workspace names", async () => {
        const cases = ["ssh-remote", "dev-container", "codespaces"]

        for (const remoteName of cases) {
            const remoteNameStub = vi.spyOn(vscode.env, "remoteName", "get")
            remoteNameStub.mockReturnValue(remoteName)

            const response = await getHostVersion({} as any)

            assert.strictEqual(response.platform, vscode.env.appName)
            assert.strictEqual(response.version, vscode.version)
            assert.strictEqual(response.clineType, ClineClient.VSCode)
            assert.strictEqual(response.clineVersion, ExtensionRegistryInfo.version)
            assert.strictEqual(response.remoteName, remoteName)

            remoteNameStub.mockRestore()
        }
    })

    it("normalizes empty remote workspace names to undefined", async () => {
        vi.spyOn(vscode.env, "remoteName", "get").mockReturnValue("")

        const response = await getHostVersion({} as any)

        assert.strictEqual(response.remoteName, undefined)
    })

    it("keeps local workspaces without a remoteName", async () => {
        vi.spyOn(vscode.env, "remoteName", "get").mockReturnValue(undefined)

        const response = await getHostVersion({} as any)

        assert.strictEqual(response.remoteName, undefined)
    })
})
