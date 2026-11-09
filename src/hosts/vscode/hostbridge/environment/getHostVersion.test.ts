import { strict as assert } from "assert"
import { afterEach, describe, expect, it, vi } from "vitest"
// sinon import removed
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { ClineClient } from "@/shared/cline"
import { GetHostVersionResponse } from "@/shared/proto/dline/host/env"

// Historical emitted .js siblings exist in this checkout. Exercise the TS owner.
const { getHostVersion } = await vi.importActual<typeof import("./getHostVersion")>("./getHostVersion.ts")

describe("Hostbridge - Env - getHostVersion", () => {
    const sandbox = { mockRestore: () => {} }

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each(["en", "zh-CN", "zh-TW", "ZH-hans", ""])('projects the raw host display language "%s"', async (language) => {
        vi.spyOn(vscode.env, "language", "get").mockReturnValue(language)

        const response = await getHostVersion({})

        expect(response.displayLanguage).toBe(language)
    })

    it.each([undefined, "", "zh-CN"])('preserves optional display language "%s" across codecs', (displayLanguage) => {
        const response = GetHostVersionResponse.fromPartial({
            platform: "VS Code",
            remoteName: "ssh-remote",
            displayLanguage,
        })

        const decoded = GetHostVersionResponse.decode(GetHostVersionResponse.encode(response).finish())
        expect(decoded.displayLanguage).toBe(displayLanguage)
        expect(decoded.remoteName).toBe("ssh-remote")
        const json = GetHostVersionResponse.toJSON(response)
        expect(GetHostVersionResponse.fromJSON(json).displayLanguage).toBe(displayLanguage)
        expect(GetHostVersionResponse.fromJSON({ platform: "old host" }).displayLanguage).toBeUndefined()
        expect(GetHostVersionResponse.decode(new Uint8Array()).displayLanguage).toBeUndefined()
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
})
