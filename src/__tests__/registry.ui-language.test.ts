import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { ClineClient } from "@/shared/cline"

// Exercise the real metadata cache, not the global StateManager setup mock.
vi.unmock("@/registry")

import { ExtensionRegistryInfo, HostRegistryInfo } from "../registry"

afterEach(() => vi.restoreAllMocks())

describe("HostRegistryInfo display language", () => {
    it("retains raw display language from the existing startup metadata read", async () => {
        const getHostVersion = vi.spyOn(HostProvider.env, "getHostVersion").mockResolvedValue({
            platform: "VS Code",
            version: "1.103.0",
            clineType: ClineClient.VSCode,
            clineVersion: "test-extension",
            displayLanguage: "ZH-hant-TW",
        })

        await HostRegistryInfo.init("test-installation")

        expect(HostRegistryInfo.get()).toMatchObject({
            platform: "VS Code",
            hostVersion: "1.103.0",
            ide: ClineClient.VSCode,
            extensionVersion: "test-extension",
            distinctId: "test-installation",
            displayLanguage: "ZH-hant-TW",
        })
        for (let i = 0; i < 3; i++) expect(HostRegistryInfo.get()?.displayLanguage).toBe("ZH-hant-TW")
        expect(getHostVersion).toHaveBeenCalledExactlyOnceWith({})
    })

    it("caches metadata absence after failure and retries only at the next initialization boundary", async () => {
        const getHostVersion = vi.spyOn(HostProvider.env, "getHostVersion")
        getHostVersion.mockRejectedValueOnce(new Error("Host bridge unavailable"))
        getHostVersion.mockResolvedValueOnce({ displayLanguage: "zh-CN" })

        await HostRegistryInfo.init("failed-startup")

        for (let i = 0; i < 3; i++) expect(HostRegistryInfo.get()?.displayLanguage).toBeUndefined()
        expect(HostRegistryInfo.get()?.distinctId).toBe("failed-startup")
        expect(getHostVersion).toHaveBeenCalledOnce()
        await HostRegistryInfo.init("reopened-host")
        expect(HostRegistryInfo.get()?.displayLanguage).toBe("zh-CN")
        expect(getHostVersion).toHaveBeenCalledTimes(2)
    })

    it("accepts an older host without the optional field and replaces prior metadata on reinitialization", async () => {
        const getHostVersion = vi.spyOn(HostProvider.env, "getHostVersion")
        getHostVersion.mockResolvedValueOnce({ displayLanguage: "zh-CN" }).mockResolvedValueOnce({ platform: "old host" })

        await HostRegistryInfo.init("first-startup")
        await HostRegistryInfo.init("next-startup")

        expect(HostRegistryInfo.get()).toMatchObject({
            platform: "old host",
            distinctId: "next-startup",
            extensionVersion: ExtensionRegistryInfo.version,
        })
        expect(HostRegistryInfo.get()?.displayLanguage).toBeUndefined()
        expect(getHostVersion).toHaveBeenCalledTimes(2)
    })
})
