import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ensureToolCallCheckpoint, type ToolCallSideEffectPort } from "../ToolCallSideEffects"

/** A restore point that stays queued until the operation that owns the call aborts. */
function queuedRestorePoint(): ToolCallSideEffectPort & { ensurePreEditCheckpoint: ReturnType<typeof vi.fn> } {
    return {
        ensurePreEditCheckpoint: vi.fn(
            (signal?: AbortSignal) =>
                new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("checkpoint wait aborted")), { once: true })
                }),
        ),
    }
}

// The main task and a subagent both start an edit only on this answer, so the
// rule that a stopped operation never starts its edit has one source.
describe("ensureToolCallCheckpoint", () => {
    it("lets the edit run once its restore point is in place", async () => {
        const port: ToolCallSideEffectPort = { ensurePreEditCheckpoint: vi.fn(async () => {}) }
        const { signal } = new AbortController()

        await expect(ensureToolCallCheckpoint(port, DlineDefaultTool.FILE_EDIT, signal)).resolves.toBe(true)
        expect(port.ensurePreEditCheckpoint).toHaveBeenCalledOnce()
    })

    it("refuses the edit when its operation stops while the restore point waits", async () => {
        const port = queuedRestorePoint()
        const operation = new AbortController()

        const proceed = ensureToolCallCheckpoint(port, DlineDefaultTool.FILE_EDIT, operation.signal)
        await vi.waitFor(() => expect(port.ensurePreEditCheckpoint).toHaveBeenCalledWith(operation.signal))
        operation.abort()

        await expect(proceed).resolves.toBe(false)
    })

    // A failed restore point is a lost side feature, not a reason to refuse the edit.
    it("lets the edit run when the restore point fails", async () => {
        const port: ToolCallSideEffectPort = {
            ensurePreEditCheckpoint: vi.fn(async () => {
                throw new Error("shadow git unavailable")
            }),
        }

        const { signal } = new AbortController()

        await expect(ensureToolCallCheckpoint(port, DlineDefaultTool.FILE_EDIT, signal)).resolves.toBe(true)
    })

    it("does not hold back a tool that owes no restore point", async () => {
        const port = queuedRestorePoint()
        const { signal } = new AbortController()

        await expect(ensureToolCallCheckpoint(port, DlineDefaultTool.LIST_FILES, signal)).resolves.toBe(true)
        expect(port.ensurePreEditCheckpoint).not.toHaveBeenCalled()
    })
})
