import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

/**
 * An abandoned telemetry lease must not degrade a real extension host.
 *
 * Two Dline builds shared one data directory and contended on
 * `secrets/otel/issue-grant.json.lck`. The lock judged staleness by the file
 * modification time, so a fresh touch by a sync or backup tool kept an abandoned
 * lock alive for another full timeout, and a lock created but never written was
 * reported as corrupted.
 *
 * The functional layer already proves the lease rules directly. This test proves
 * the host-level consequence: with exactly that abandoned lock on disk, VS Code
 * still starts, a Task still runs to completion, and the host never reports the
 * untouched leftover as a corrupted lock before it has a reason to write.
 */

const DEAD_PID = 999_999
const LEASE_MS = 10_000
const ABANDONED_OWNER = "e2e-abandoned-owner"

interface SeededLease {
    readonly lockPath: string
    readonly grantPath: string
}

/**
 * Seed an abandoned issue-grant lease whose file modification time is fresh.
 *
 * @param dlineDir Per-test Dline data root shared with the extension host.
 * @returns Paths used to assert the host behavior.
 */
async function seedAbandonedLease(dlineDir: string): Promise<SeededLease> {
    const secretsDir = path.join(dlineDir, "data", "secrets", "otel")
    await mkdir(secretsDir, { recursive: true })
    const grantPath = path.join(secretsDir, "issue-grant.json")
    const lockPath = `${grantPath}.lck`
    // The owner is gone well past its declared lease while mtime is current:
    // judging by mtime is exactly the behaviour this Bugfix removed.
    await writeFile(
        lockPath,
        JSON.stringify({ pid: DEAD_PID, ownerId: ABANDONED_OWNER, ts: Date.now() - 30_000, ttlMs: LEASE_MS }),
        "utf8",
    )
    return { lockPath, grantPath }
}

/**
 * Read the owner identity recorded in a lock file.
 *
 * @param lockPath Absolute path of the `.lck` file.
 * @returns The recorded owner, or "" when the file is absent or unreadable.
 */
async function readLockOwner(lockPath: string): Promise<string> {
    try {
        const raw = await readFile(lockPath, "utf8")
        const payload = JSON.parse(raw) as { ownerId?: unknown }
        return typeof payload.ownerId === "string" ? payload.ownerId : ""
    } catch {
        return ""
    }
}

/**
 * Whether a path currently exists.
 *
 * @param target Absolute path to check.
 * @returns True when the path can be stat-ed.
 */
async function exists(target: string): Promise<boolean> {
    return stat(target)
        .then(() => true)
        .catch(() => false)
}

e2e(
    "An abandoned telemetry lease does not degrade the extension host",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        const { lockPath } = await seedAbandonedLease(dlineDir)
        expect(await readLockOwner(lockPath)).toBe(ABANDONED_OWNER)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "message", text: "ABANDONED_LEASE_E2E_OK" })

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)

            const input = sidebar.getByTestId("chat-input")
            await input.fill("Run one task while an abandoned telemetry lease is on disk.")
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("ABANDONED_LEASE_E2E_OK", { exact: false })).toBeVisible({ timeout: 120_000 })

            // The leftover belongs to a dead owner, so it must not be rewritten or
            // removed as a side effect of starting up: nothing in this scenario
            // writes the grant, and a lock is only touched on a real write.
            expect(await readLockOwner(lockPath)).toBe(ABANDONED_OWNER)
            expect(await exists(lockPath)).toBe(true)

            // The reported symptom was this line appearing for an untouched
            // leftover. Without a writer there is no takeover to report, and this
            // reads the host's own Output log, so a missing log fails the test
            // instead of letting the assertion pass against an empty string.
            const output = await E2ETestHelper.readDlineOutput(userDataDir)
            expect(output).not.toContain("Breaking stale/corrupted lock")

            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
