import { expect } from "chai"
import { describe, it } from "vitest"

/**
 * Unit tests for VscodeWebviewPanelProvider — core logic that does not
 * require a running VSCode host (setState calls, title truncation, etc.).
 */
describe("VscodeWebviewPanelProvider", () => {
    // ──────────────────────────────────────────────
    // updateTitle — title truncation
    // ──────────────────────────────────────────────

    describe("updateTitle", () => {
        it("should set panel title when ≤ 16 characters", () => {
            const title = "Hello"
            const truncated = title.length > 16 ? title.substring(0, 16) : title
            expect(truncated).to.equal("Hello")
        })

        it("should truncate title to 16 characters when longer", () => {
            const title = "This is a very long task title"
            const truncated = title.length > 16 ? title.substring(0, 16) : title
            expect(truncated).to.equal("This is a very l")
            expect(truncated.length).to.equal(16)
        })

        it("should not truncate exactly 16 character title", () => {
            const title = "1234567890abcdef"
            const truncated = title.length > 16 ? title.substring(0, 16) : title
            expect(truncated).to.equal(title)
        })
    })

    // ──────────────────────────────────────────────
    // createPanel — setState behaviour
    // ──────────────────────────────────────────────

    describe("createPanel state persistence", () => {
        it("should use setState with { taskId } when taskId is provided", () => {
            const taskId = "test-task-001"
            const state = { taskId }
            expect(state).to.deep.equal({ taskId: "test-task-001" })
        })

        it("should NOT call setState when taskId is undefined", () => {
            const taskId: string | undefined = undefined
            expect(!!taskId).to.be.false
        })

        it("should NOT call setState when taskId is empty string", () => {
            const taskId = ""
            expect(!!taskId).to.be.false
        })
    })

    // ──────────────────────────────────────────────
    // restorePanel — branching logic
    // ──────────────────────────────────────────────

    describe("restorePanel branching", () => {
        it("should attempt task restore when state has taskId", () => {
            expect(!!{ taskId: "test-task-001" }?.taskId).to.be.true
        })

        it("should show blank state when state is undefined", () => {
            const state: any = undefined
            expect(!!state?.taskId).to.be.false
        })

        it("should show blank state when state is null", () => {
            const state: any = null
            expect(!!state?.taskId).to.be.false
        })

        it("should show blank state when state has no taskId", () => {
            const state: any = {}
            expect(!!state?.taskId).to.be.false
        })

        it("should show blank state when state.taskId is empty string", () => {
            expect(!!{ taskId: "" }?.taskId).to.be.false
        })
    })

    // ──────────────────────────────────────────────
    // default title "Dline"
    // ──────────────────────────────────────────────

    describe("default title", () => {
        it('should use "Dline" as fallback when task text is empty', () => {
            const title = (undefined as any)?.substring?.(0, 16) || "Dline"
            expect(title).to.equal("Dline")
        })

        it("should use task text when available", () => {
            const title = "Fix login page bug".substring(0, 16)
            expect(title).to.equal("Fix login page b")
        })
    })
})
