import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type McpVariableOwner, McpVariableStore } from "@/core/storage/secrets/McpVariableStore"
import { type McpVariablePrompt, McpVariableResolver } from "../McpVariableResolver"

const GLOBAL_SERVER: McpVariableOwner = { source: "settings", serverName: "github" }
const WORKSPACE_SERVER: McpVariableOwner = { source: "workspace", serverName: "github@abc123" }
const OTHER_SERVER: McpVariableOwner = { source: "settings", serverName: "linear" }

describe("McpVariableResolver", () => {
    let dataDir: string
    let store: McpVariableStore

    beforeEach(async () => {
        dataDir = await mkdtemp(path.join(os.tmpdir(), "dline-mcp-variables-"))
        store = new McpVariableStore({ dataDir })
    })

    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true })
    })

    function resolverWith(prompt: McpVariablePrompt, environment: Record<string, string> = {}) {
        return new McpVariableResolver({ store, prompt, environment: (name) => environment[name] })
    }

    it("uses the value saved for the server before the process environment and does not prompt", async () => {
        await store.save(GLOBAL_SERVER, "TOKEN", "saved-token")
        const prompt = vi.fn<McpVariablePrompt>()
        const resolver = resolverWith(prompt, { TOKEN: "env-token" })

        const result = await resolver.resolve(GLOBAL_SERVER, "GitHub", { env: { AUTH: "Bearer ${env:TOKEN}" } })

        expect(result).toEqual({ kind: "resolved", config: { env: { AUTH: "Bearer saved-token" } } })
        expect(prompt).not.toHaveBeenCalled()
    })

    it("defers instead of asking while prompting is not allowed, and still uses known values", async () => {
        await store.save(GLOBAL_SERVER, "KNOWN", "saved")
        const prompt = vi.fn<McpVariablePrompt>()
        const resolver = new McpVariableResolver({ store, prompt, environment: () => undefined, canPrompt: () => false })

        const known = await resolver.resolve(GLOBAL_SERVER, "GitHub", { url: "${env:KNOWN}" })
        const unknown = await resolver.resolve(GLOBAL_SERVER, "GitHub", { url: "${env:TOKEN}" })

        expect(known).toEqual({ kind: "resolved", config: { url: "saved" } })
        expect(unknown).toEqual({ kind: "deferred", variable: "TOKEN" })
        expect(prompt).not.toHaveBeenCalled()
    })

    it("falls back to the process environment without prompting or saving", async () => {
        const prompt = vi.fn<McpVariablePrompt>()
        const resolver = resolverWith(prompt, { TOKEN: "env-token" })

        const result = await resolver.resolve(GLOBAL_SERVER, "GitHub", { url: "${env:TOKEN}" })

        expect(result).toEqual({ kind: "resolved", config: { url: "env-token" } })
        expect(prompt).not.toHaveBeenCalled()
        expect(store.read(GLOBAL_SERVER, "TOKEN")).toBeUndefined()
    })

    it("prompts only when no value exists and saves the answer for this server in its own scope", async () => {
        const prompt = vi.fn<McpVariablePrompt>().mockResolvedValue("typed-token")
        const resolver = resolverWith(prompt)

        const result = await resolver.resolve(WORKSPACE_SERVER, "GitHub", { args: ["--token", "${env:TOKEN}"] })

        expect(result).toEqual({ kind: "resolved", config: { args: ["--token", "typed-token"] } })
        expect(prompt).toHaveBeenCalledWith({ serverLabel: "GitHub", variable: "TOKEN" })
        expect(store.read(WORKSPACE_SERVER, "TOKEN")).toBe("typed-token")
        // Neither the same name in the global scope nor another server sees the value.
        expect(store.read({ source: "settings", serverName: WORKSPACE_SERVER.serverName }, "TOKEN")).toBeUndefined()
        expect(store.read(OTHER_SERVER, "TOKEN")).toBeUndefined()
    })

    it.each([
        ["cancelled", undefined],
        ["submitted empty", ""],
    ])("reports the variable as missing when the prompt is %s and saves nothing", async (_case, answer) => {
        const resolver = resolverWith(vi.fn<McpVariablePrompt>().mockResolvedValue(answer))

        const result = await resolver.resolve(GLOBAL_SERVER, "GitHub", { env: { A: "${env:FIRST}", B: "${env:SECOND}" } })

        expect(result).toEqual({ kind: "missing", variable: "FIRST" })
        expect(store.read(GLOBAL_SERVER, "FIRST")).toBeUndefined()
    })

    it("asks once when two connects of the same server need the same variable at the same time", async () => {
        let answer: (value: string) => void = () => {}
        const prompt = vi.fn<McpVariablePrompt>(() => new Promise<string>((resolve) => (answer = resolve)))
        const resolver = resolverWith(prompt)

        const first = resolver.resolve(GLOBAL_SERVER, "GitHub", { url: "${env:TOKEN}" })
        const second = resolver.resolve(GLOBAL_SERVER, "GitHub", { url: "${env:TOKEN}" })
        await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
        answer("typed-token")

        await expect(first).resolves.toEqual({ kind: "resolved", config: { url: "typed-token" } })
        await expect(second).resolves.toEqual({ kind: "resolved", config: { url: "typed-token" } })
        expect(prompt).toHaveBeenCalledTimes(1)
    })
})

describe("McpVariableStore", () => {
    let dataDir: string

    beforeEach(async () => {
        dataDir = await mkdtemp(path.join(os.tmpdir(), "dline-mcp-variables-"))
    })

    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true })
    })

    it("sees a value another window saved, and clear forgets only that server's values in that scope", async () => {
        const thisWindow = new McpVariableStore({ dataDir })
        const otherWindow = new McpVariableStore({ dataDir })
        await otherWindow.save(GLOBAL_SERVER, "TOKEN", "a")
        await otherWindow.save(GLOBAL_SERVER, "ORG", "b")
        await otherWindow.save(WORKSPACE_SERVER, "TOKEN", "c")
        await otherWindow.save(OTHER_SERVER, "TOKEN", "d")

        expect(thisWindow.read(GLOBAL_SERVER, "TOKEN")).toBe("a")

        await thisWindow.clear(GLOBAL_SERVER)

        expect(otherWindow.read(GLOBAL_SERVER, "TOKEN")).toBeUndefined()
        expect(otherWindow.read(GLOBAL_SERVER, "ORG")).toBeUndefined()
        expect(otherWindow.read(WORKSPACE_SERVER, "TOKEN")).toBe("c")
        expect(otherWindow.read(OTHER_SERVER, "TOKEN")).toBe("d")
    })
})
