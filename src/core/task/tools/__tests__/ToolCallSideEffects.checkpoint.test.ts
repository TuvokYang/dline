import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ensureToolCallCheckpoint, type ToolCallSideEffectPort } from "../ToolCallSideEffects"

function toolUse(name: DlineDefaultTool): ToolUse {
    return {
        type: "tool_use",
        name,
        params: {},
        partial: false,
        ts: 170,
        function_id: "function-170",
        dline_tid: "tool-170",
    }
}

/** A restore point that stays queued until the operation that owns the call aborts. */
function queuedRestorePoint(): ToolCallSideEffectPort & { ensurePreEditCheckpoint: ReturnType<typeof vi.fn> } {
    return {
        ensurePreEditCheckpoint: vi.fn(
            (_source, signal?: AbortSignal) =>
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

        await expect(ensureToolCallCheckpoint(port, toolUse(DlineDefaultTool.FILE_EDIT), signal)).resolves.toBe(true)
        expect(port.ensurePreEditCheckpoint).toHaveBeenCalledWith(
            { kind: "pre_edit", toolTs: 170, toolName: DlineDefaultTool.FILE_EDIT, dlineTid: "tool-170" },
            signal,
        )
    })

    it("refuses the edit when its operation stops while the restore point waits", async () => {
        const port = queuedRestorePoint()
        const operation = new AbortController()

        const proceed = ensureToolCallCheckpoint(port, toolUse(DlineDefaultTool.FILE_EDIT), operation.signal)
        await vi.waitFor(() =>
            expect(port.ensurePreEditCheckpoint).toHaveBeenCalledWith(
                { kind: "pre_edit", toolTs: 170, toolName: DlineDefaultTool.FILE_EDIT, dlineTid: "tool-170" },
                operation.signal,
            ),
        )
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

        await expect(ensureToolCallCheckpoint(port, toolUse(DlineDefaultTool.FILE_EDIT), signal)).resolves.toBe(true)
    })

    it("keeps subagent edits standalone when their internal tool row is not part of parent presentation", async () => {
        const ensurePreEditCheckpoint = vi.fn(async () => {})
        const port: ToolCallSideEffectPort = { ensurePreEditCheckpoint }
        const { signal } = new AbortController()

        await expect(ensureToolCallCheckpoint(port, toolUse(DlineDefaultTool.FILE_EDIT), signal, "standalone")).resolves.toBe(
            true,
        )

        expect(ensurePreEditCheckpoint).toHaveBeenCalledWith(undefined, signal)
    })

    it("does not hold back a tool that owes no restore point", async () => {
        const port = queuedRestorePoint()
        const { signal } = new AbortController()

        await expect(ensureToolCallCheckpoint(port, toolUse(DlineDefaultTool.LIST_FILES), signal)).resolves.toBe(true)
        expect(port.ensurePreEditCheckpoint).not.toHaveBeenCalled()
    })
})
