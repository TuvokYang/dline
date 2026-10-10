import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { OAuthFlowError, type OAuthFlowLease, type OAuthFlowLeaseHandle, type OAuthFlowLeaseOwner } from "./types"

const INCOMPLETE_LEASE_GRACE_MS = 10_000

interface StoredLease extends OAuthFlowLeaseOwner {
    leaseId: string
    pid: number
    createdAt: number
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export class FileOAuthFlowLease implements OAuthFlowLease {
    constructor(private readonly leasePath: string) {}

    async acquire(owner: OAuthFlowLeaseOwner): Promise<OAuthFlowLeaseHandle> {
        await fs.mkdir(path.dirname(this.leasePath), { recursive: true })
        for (let attempt = 0; attempt < 3; attempt++) {
            const stored: StoredLease = { ...owner, leaseId: randomUUID(), pid: process.pid, createdAt: Date.now() }
            try {
                const handle = await fs.open(this.leasePath, "wx", 0o600)
                try {
                    await handle.writeFile(JSON.stringify(stored), "utf8")
                } finally {
                    await handle.close()
                }
                return { release: () => this.release(stored.leaseId) }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
            }

            const existing = await this.readLease()
            if ((existing && isProcessAlive(existing.pid)) || (!existing && (await this.isIncompleteLeaseFresh()))) {
                throw new OAuthFlowError("FLOW_ALREADY_IN_PROGRESS", "Another OAuth authorization flow is already active.")
            }
            await fs.unlink(this.leasePath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error
            })
        }
        throw new OAuthFlowError("FLOW_ALREADY_IN_PROGRESS", "Another OAuth authorization flow is already active.")
    }

    private async readLease(): Promise<StoredLease | undefined> {
        try {
            const value: unknown = JSON.parse(await fs.readFile(this.leasePath, "utf8"))
            if (!value || typeof value !== "object") return undefined
            const record = value as Partial<StoredLease>
            return typeof record.leaseId === "string" && typeof record.pid === "number" ? (record as StoredLease) : undefined
        } catch {
            return undefined
        }
    }

    private async isIncompleteLeaseFresh(): Promise<boolean> {
        try {
            const stat = await fs.stat(this.leasePath)
            return Date.now() - stat.mtimeMs < INCOMPLETE_LEASE_GRACE_MS
        } catch {
            return false
        }
    }

    private async release(leaseId: string): Promise<void> {
        const existing = await this.readLease()
        if (!existing || existing.leaseId !== leaseId) return
        await fs.unlink(this.leasePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
        })
    }
}
