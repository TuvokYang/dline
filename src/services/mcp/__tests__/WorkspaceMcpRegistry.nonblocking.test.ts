import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { WorkspaceMcpRegistry } from "../WorkspaceMcpRegistry"

let registry: WorkspaceMcpRegistry | undefined
let temporaryDirectory: string | undefined

afterEach(async () => {
    await registry?.dispose()
    registry = undefined
    if (temporaryDirectory) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true })
        temporaryDirectory = undefined
    }
})

describe("WorkspaceMcpRegistry change delivery", () => {
    it("does not block owner registration on asynchronous server reconciliation", async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-workspace-mcp-nonblocking-"))
        const descriptorDirectory = path.join(temporaryDirectory, ".agents", "mcp")
        await fs.mkdir(descriptorDirectory, { recursive: true })
        await fs.writeFile(
            path.join(descriptorDirectory, "hanging.json"),
            JSON.stringify({ name: "hanging", type: "stdio", command: process.execPath }),
            "utf8",
        )

        let markReconcileStarted!: () => void
        const reconcileStarted = new Promise<void>((resolve) => {
            markReconcileStarted = resolve
        })
        let releaseReconcile!: () => void
        const reconcileRelease = new Promise<void>((resolve) => {
            releaseReconcile = resolve
        })
        registry = new WorkspaceMcpRegistry(async () => {
            markReconcileStarted()
            await reconcileRelease
        })

        const registration = registry.registerOwner("sidebar", [temporaryDirectory])
        await reconcileStarted
        const outcome = await Promise.race([
            registration.then(() => "resolved" as const),
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
        ])

        releaseReconcile()
        await registration
        expect(outcome).toBe("resolved")
    })

    it("does not reject owner registration when reconciliation throws synchronously", async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-workspace-mcp-sync-failure-"))
        const descriptorDirectory = path.join(temporaryDirectory, ".agents", "mcp")
        await fs.mkdir(descriptorDirectory, { recursive: true })
        await fs.writeFile(
            path.join(descriptorDirectory, "failing.json"),
            JSON.stringify({ name: "failing", type: "stdio", command: process.execPath }),
            "utf8",
        )
        registry = new WorkspaceMcpRegistry(() => {
            throw new Error("reconcile failed")
        })

        await expect(registry.registerOwner("sidebar", [temporaryDirectory])).resolves.toBeUndefined()
    })
})
