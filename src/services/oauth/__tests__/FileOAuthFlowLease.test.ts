import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileOAuthFlowLease } from "../FileOAuthFlowLease"
import { OAuthFlowError } from "../types"

describe("FileOAuthFlowLease", () => {
    let tempDir: string | undefined

    afterEach(async () => {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
        tempDir = undefined
    })

    async function createLeasePath(): Promise<string> {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-oauth-lease-"))
        return path.join(tempDir, "active-flow.json")
    }

    it("prevents another owner from acquiring the active flow", async () => {
        const leasePath = await createLeasePath()
        const left = new FileOAuthFlowLease(leasePath)
        const right = new FileOAuthFlowLease(leasePath)
        const handle = await left.acquire({ flowId: "flow-a", profileId: "profile-a", strategyId: "test" })

        await expect(right.acquire({ flowId: "flow-b", profileId: "profile-b", strategyId: "test" })).rejects.toMatchObject({
            code: "FLOW_ALREADY_IN_PROGRESS",
        })

        await handle.release()
        const next = await right.acquire({ flowId: "flow-b", profileId: "profile-b", strategyId: "test" })
        await next.release()
    })

    it("does not reclaim a fresh lease file before its owner finishes writing metadata", async () => {
        const leasePath = await createLeasePath()
        await fs.writeFile(leasePath, "", "utf8")
        const lease = new FileOAuthFlowLease(leasePath)

        await expect(lease.acquire({ flowId: "new", profileId: "profile", strategyId: "test" })).rejects.toMatchObject({
            code: "FLOW_ALREADY_IN_PROGRESS",
        })
    })

    it("reclaims a lease owned by a dead process", async () => {
        const leasePath = await createLeasePath()
        await fs.writeFile(
            leasePath,
            JSON.stringify({ leaseId: "stale", pid: 2147483647, flowId: "old", profileId: "old", strategyId: "test" }),
            "utf8",
        )
        const lease = new FileOAuthFlowLease(leasePath)
        const handle = await lease.acquire({ flowId: "new", profileId: "profile", strategyId: "test" })
        const stored = JSON.parse(await fs.readFile(leasePath, "utf8")) as { flowId: string }
        expect(stored.flowId).toBe("new")
        await handle.release()
    })

    it("does not remove a lease that has been replaced by another owner", async () => {
        const leasePath = await createLeasePath()
        const lease = new FileOAuthFlowLease(leasePath)
        const handle = await lease.acquire({ flowId: "flow-a", profileId: "profile-a", strategyId: "test" })
        await fs.writeFile(
            leasePath,
            JSON.stringify({
                leaseId: "replacement",
                pid: process.pid,
                flowId: "flow-b",
                profileId: "profile-b",
                strategyId: "test",
            }),
            "utf8",
        )

        await handle.release()
        expect(JSON.parse(await fs.readFile(leasePath, "utf8"))).toMatchObject({ leaseId: "replacement" })
    })

    it("uses a typed flow conflict error", async () => {
        const leasePath = await createLeasePath()
        const lease = new FileOAuthFlowLease(leasePath)
        const handle = await lease.acquire({ flowId: "flow-a", profileId: "profile-a", strategyId: "test" })
        try {
            await lease.acquire({ flowId: "flow-b", profileId: "profile-b", strategyId: "test" })
            throw new Error("expected conflict")
        } catch (error) {
            expect(error).toBeInstanceOf(OAuthFlowError)
        }
        await handle.release()
    })
})
