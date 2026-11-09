import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Settings } from "@shared/storage/state-keys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsRepository } from "../SettingsRepository"

const directories: string[] = []
const opened: SettingsRepository[] = []
async function file(initial: Record<string, unknown> = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-away-settings-"))
    directories.push(dir)
    const target = path.join(dir, "settings.json")
    await fs.writeFile(target, JSON.stringify(initial))
    return target
}
async function open(target: string, watch = false) {
    const repository = new SettingsRepository({ filePath: target, watch })
    opened.push(repository)
    await repository.initialize()
    return repository
}
afterEach(async () => {
    await Promise.all(opened.splice(0).map((r) => r.dispose()))
    await Promise.all(directories.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe("canonical Away revocations", () => {
    it("defaults legacy metadata to zero and keeps it out of user values", async () => {
        const r = await open(await file())
        expect(r.readSnapshot().awayRevocations).toEqual({ mode: 0, automatic: 0 })
        expect(Object.keys(r.readSnapshot().values)).toEqual([])
    })

    it("commits each close/open and distinguishes automatic from mode revocation", async () => {
        const target = await file({ awayModeEnabled: true, autoAwayModeEnabled: true })
        const r = await open(target)
        const commits = await Promise.all([
            r.mutate({ autoAwayModeEnabled: false }),
            r.mutate({ autoAwayModeEnabled: true }),
            r.mutate({ awayModeEnabled: false }),
            r.mutate({ awayModeEnabled: true }),
        ])
        expect(commits.map((c) => c.snapshot.awayRevocations)).toEqual([
            { mode: 0, automatic: 1 },
            { mode: 0, automatic: 1 },
            { mode: 1, automatic: 2 },
            { mode: 1, automatic: 2 },
        ])
        const reopened = await open(target)
        expect(reopened.readSnapshot().awayRevocations).toEqual({ mode: 1, automatic: 2 })
        expect(reopened.readSnapshot().values).toMatchObject({ awayModeEnabled: true, autoAwayModeEnabled: true })
    })

    it("treats deletion as closing and preserves metadata through concurrent ordinary writes", async () => {
        const target = await file({ awayModeEnabled: true, autoAwayModeEnabled: true })
        const a = await open(target)
        const b = await open(target)
        await Promise.all([a.mutate({ awayModeEnabled: undefined }), b.mutate({ terminalOutputLineLimit: 900 })])
        const r = await open(target)
        expect(r.readSnapshot().awayRevocations).toEqual({ mode: 1, automatic: 1 })
        expect(r.readSnapshot().values.terminalOutputLineLimit).toBe(900)
        expect(r.readSnapshot().values.awayModeEnabled).toBeUndefined()
    })

    it("publishes an adopted metadata-only commit and changes its hash", async () => {
        const target = await file({ awayModeEnabled: true })
        const a = await open(target)
        const b = await open(target)
        const before = b.readSnapshot().contentHash
        const listener = vi.fn()
        b.subscribe(listener)
        await a.revokeAwayMode()
        await b.mutate({})
        expect(listener).toHaveBeenCalledTimes(1)
        const commit = listener.mock.calls[0][0]
        expect(commit.changedKeys).toEqual([])
        expect(commit.snapshot.awayRevocations).toEqual({ mode: 1, automatic: 1 })
        expect(commit.snapshot.contentHash).not.toBe(before)
        expect(commit.snapshot.values).toEqual({ awayModeEnabled: true })
    })

    it("reconciles metadata-only changes through the real watcher", async () => {
        const target = await file()
        const a = await open(target)
        const b = await open(target, true)
        const listener = vi.fn()
        b.subscribe(listener)
        await a.revokeAwayMode()
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1), { timeout: 5000 })
        expect(b.readSnapshot().awayRevocations).toEqual({ mode: 1, automatic: 1 })
        expect(listener.mock.calls[0][0].changedKeys).toEqual([])
    })

    it("rejects user metadata patches and invalid booleans without writing", async () => {
        const target = await file()
        const r = await open(target)
        const before = await fs.readFile(target, "utf8")
        await expect(
            r.mutate({ __awayRevocations: { mode: 50, automatic: 50 } } as unknown as Partial<Settings>),
        ).rejects.toThrow()
        await expect(r.mutate({ awayModeEnabled: "true" } as unknown as Partial<Settings>)).rejects.toThrow()
        expect(await fs.readFile(target, "utf8")).toBe(before)
    })

    it("signals unavailable on malformed initial metadata instead of defaulting to an authorization", async () => {
        const target = await file({ __awayRevocations: { mode: -1, automatic: 0 }, awayModeEnabled: true })
        const r = new SettingsRepository({ filePath: target, watch: false })
        opened.push(r)
        const unavailable = vi.fn()
        r.subscribeUnavailable(unavailable)
        await expect(r.initialize()).rejects.toThrow()
        expect(unavailable).toHaveBeenCalledTimes(1)
        expect(() => r.readSnapshot()).toThrow()
    })

    it("withdraws the readable snapshot on disk failure and only recovers after a successful read", async () => {
        const target = await file({ awayModeEnabled: true })
        const r = await open(target)
        const unavailable = vi.fn()
        r.subscribeUnavailable(unavailable)
        await fs.writeFile(target, "{")
        await expect(r.mutate({ awayModeEnabled: true })).rejects.toThrow()
        expect(unavailable).toHaveBeenCalledTimes(1)
        expect(() => r.readSnapshot()).toThrow()
        await fs.writeFile(target, JSON.stringify({ awayModeEnabled: true, __awayRevocations: { mode: 7, automatic: 8 } }))
        await r.mutate({})
        expect(r.readSnapshot().awayRevocations).toEqual({ mode: 7, automatic: 8 })
    })
})
