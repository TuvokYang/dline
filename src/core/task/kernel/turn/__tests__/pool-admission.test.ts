import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { type AdmissionBlock, decideAdmission, poolHasDrained } from "../pool-admission"
import { LANE_DIFF_EDITOR, resolveToolLanes } from "../tool-lanes"

function block(overrides: Partial<AdmissionBlock> & Pick<AdmissionBlock, "dlineTid" | "index">): AdmissionBlock {
	return {
		lanes: [],
		isTurnEnding: false,
		...overrides,
	}
}

describe("pool admission", () => {
	describe("purity", () => {
		it("returns the same decision for the same input", () => {
			const input = {
				pending: [block({ dlineTid: "a", index: 0 }), block({ dlineTid: "b", index: 1 })],
				running: [],
				limit: 1,
			}

			expect(decideAdmission(input)).toEqual(decideAdmission(input))
		})

		it("does not mutate the supplied block lists", () => {
			const pending = [block({ dlineTid: "b", index: 1 }), block({ dlineTid: "a", index: 0 })]
			const running = [block({ dlineTid: "r", index: 9, lanes: [LANE_DIFF_EDITOR] })]
			const pendingSnapshot = [...pending]
			const runningSnapshot = [...running]

			decideAdmission({ pending, running, limit: 4 })

			expect(pending).toEqual(pendingSnapshot)
			expect(running).toEqual(runningSnapshot)
		})
	})

	describe("limit", () => {
		it("admits up to the limit and refuses the rest", () => {
			const result = decideAdmission({
				pending: [
					block({ dlineTid: "a", index: 0 }),
					block({ dlineTid: "b", index: 1 }),
					block({ dlineTid: "c", index: 2 }),
				],
				running: [],
				limit: 2,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["a", "b"])
			expect(result.refuse).toEqual([{ block: expect.objectContaining({ dlineTid: "c" }), reason: "limit_reached" }])
		})

		it("counts running work against the limit", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "a", index: 0 })],
				running: [block({ dlineTid: "r", index: 9 })],
				limit: 1,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse[0].reason).toBe("limit_reached")
		})

		it("admits nothing at a limit of zero", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "a", index: 0 })],
				running: [],
				limit: 0,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse[0].reason).toBe("limit_reached")
		})

		it("treats a non-finite limit as no capacity rather than unlimited", () => {
			// Math.floor(NaN) is NaN and every `occupied >= NaN` is false, so a
			// misconfigured limit would otherwise mean unbounded concurrency.
			const result = decideAdmission({
				pending: [block({ dlineTid: "a", index: 0 })],
				running: [],
				limit: Number.NaN,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse[0].reason).toBe("limit_reached")
		})
	})

	describe("lanes", () => {
		it("refuses a block whose lane a running execution holds", () => {
			const editLanes = resolveToolLanes(ClineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/a.ts"] })
			const writeLanes = resolveToolLanes(ClineDefaultTool.FILE_NEW, { canonicalWritePaths: ["/repo/b.ts"] })

			const result = decideAdmission({
				pending: [block({ dlineTid: "pending-write", index: 1, lanes: writeLanes })],
				running: [block({ dlineTid: "running-edit", index: 0, lanes: editLanes })],
				limit: 8,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse[0].reason).toBe("lane_held")
		})

		it("refuses the second of two pending blocks that share a lane", () => {
			const lanes = resolveToolLanes(ClineDefaultTool.BROWSER)

			const result = decideAdmission({
				pending: [block({ dlineTid: "a", index: 0, lanes }), block({ dlineTid: "b", index: 1, lanes })],
				running: [],
				limit: 8,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["a"])
			expect(result.refuse[0]).toEqual({
				block: expect.objectContaining({ dlineTid: "b" }),
				reason: "lane_held",
			})
		})

		it("lets unrelated lanes run together", () => {
			const result = decideAdmission({
				pending: [
					block({ dlineTid: "browser", index: 0, lanes: resolveToolLanes(ClineDefaultTool.BROWSER) }),
					block({ dlineTid: "command", index: 1, lanes: resolveToolLanes(ClineDefaultTool.BASH) }),
					block({ dlineTid: "read", index: 2, lanes: resolveToolLanes(ClineDefaultTool.FILE_READ) }),
				],
				running: [],
				limit: 8,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["browser", "command", "read"])
			expect(result.refuse).toEqual([])
		})

		it("keeps a blocked lane blocked for later candidates", () => {
			const lanes = resolveToolLanes(ClineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/a.ts"] })

			const result = decideAdmission({
				pending: [block({ dlineTid: "second", index: 1, lanes }), block({ dlineTid: "third", index: 2, lanes })],
				running: [block({ dlineTid: "first", index: 0, lanes })],
				limit: 8,
			})

			// Both wait; admitting "third" ahead of "second" would reorder the
			// edits against the order the assistant wrote them.
			expect(result.admit).toEqual([])
			expect(result.refuse.map((entry) => entry.block.dlineTid)).toEqual(["second", "third"])
		})

		it("blocks every lane a refused block needs, not only the contended one", () => {
			// running holds x. A needs [x,y] and is refused. B needs [y,z] and is
			// refused on y. If B's z is not also blocked, C[z] overtakes B — on a
			// lane B is still waiting for.
			const result = decideAdmission({
				pending: [
					block({ dlineTid: "a", index: 0, lanes: ["x", "y"] }),
					block({ dlineTid: "b", index: 1, lanes: ["y", "z"] }),
					block({ dlineTid: "c", index: 2, lanes: ["z"] }),
				],
				running: [block({ dlineTid: "running", index: 9, lanes: ["x"] })],
				limit: 8,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse.map((entry) => entry.block.dlineTid)).toEqual(["a", "b", "c"])
		})
	})

	describe("ordering", () => {
		it("considers blocks in assistant order regardless of list order", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "later", index: 5 }), block({ dlineTid: "earlier", index: 1 })],
				running: [],
				limit: 1,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["earlier"])
		})

		it("does not let an unrestricted block overtake an older lane-blocked one", () => {
			const editLanes = resolveToolLanes(ClineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/a.ts"] })

			const result = decideAdmission({
				pending: [
					block({ dlineTid: "blocked-edit", index: 0, lanes: editLanes }),
					block({ dlineTid: "free-read", index: 1 }),
				],
				running: [block({ dlineTid: "running-edit", index: 9, lanes: editLanes })],
				limit: 8,
			})

			// The read may proceed: it shares nothing with the blocked edit, and
			// head-of-line blocking by lane rather than by queue is the point.
			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["free-read"])
			expect(result.refuse.map((entry) => entry.block.dlineTid)).toEqual(["blocked-edit"])
		})
	})

	describe("turn-ending barrier", () => {
		it("refuses a turn-ending block while work is running", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "attempt", index: 2, isTurnEnding: true })],
				running: [block({ dlineTid: "r", index: 0 })],
				limit: 8,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse[0].reason).toBe("awaiting_drain")
		})

		it("refuses a turn-ending block while earlier work is unfinished", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "attempt", index: 2, isTurnEnding: true })],
				running: [],
				limit: 8,
				hasUnfinishedEarlierWork: true,
			})

			expect(result.refuse[0].reason).toBe("awaiting_drain")
		})

		it("refuses a turn-ending block admitted alongside ordinary work", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "read", index: 0 }), block({ dlineTid: "attempt", index: 1, isTurnEnding: true })],
				running: [],
				limit: 8,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["read"])
			expect(result.refuse[0]).toEqual({
				block: expect.objectContaining({ dlineTid: "attempt" }),
				reason: "awaiting_drain",
			})
		})

		it("admits a turn-ending block once the pool has drained", () => {
			const result = decideAdmission({
				pending: [block({ dlineTid: "attempt", index: 2, isTurnEnding: true })],
				running: [],
				limit: 8,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["attempt"])
		})

		it("refuses ordinary work that follows an admitted turn-ending block", () => {
			// "Runs alone" has to hold in both directions. Admitting the read
			// here would put ordinary work beside the tool that is handing
			// control back to the user.
			const result = decideAdmission({
				pending: [block({ dlineTid: "attempt", index: 0, isTurnEnding: true }), block({ dlineTid: "read", index: 1 })],
				running: [],
				limit: 8,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["attempt"])
			expect(result.refuse).toEqual([{ block: expect.objectContaining({ dlineTid: "read" }), reason: "awaiting_drain" }])
		})

		it("refuses a turn-ending block when earlier work was refused for capacity", () => {
			// The earlier block is not running, but it is still outstanding: it
			// will start as soon as a slot frees, which must not be beside the
			// turn-ending tool.
			const result = decideAdmission({
				pending: [block({ dlineTid: "read", index: 0 }), block({ dlineTid: "attempt", index: 1, isTurnEnding: true })],
				running: [],
				limit: 0,
			})

			expect(result.admit).toEqual([])
			expect(result.refuse.map((entry) => entry.reason)).toEqual(["limit_reached", "awaiting_drain"])
		})

		it("admits a turn-ending block even at a limit of zero once drained", () => {
			// The barrier, not the pool limit, governs a turn-ending tool; a
			// limit of 1 forced by disabled parallelism must not deadlock it.
			const result = decideAdmission({
				pending: [block({ dlineTid: "attempt", index: 0, isTurnEnding: true })],
				running: [],
				limit: 0,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["attempt"])
		})

		it("admits only one turn-ending block", () => {
			const result = decideAdmission({
				pending: [
					block({ dlineTid: "attempt", index: 0, isTurnEnding: true }),
					block({ dlineTid: "ask", index: 1, isTurnEnding: true }),
				],
				running: [],
				limit: 8,
			})

			expect(result.admit.map((entry) => entry.dlineTid)).toEqual(["attempt"])
			expect(result.refuse[0].reason).toBe("awaiting_drain")
		})
	})

	describe("poolHasDrained", () => {
		it("is true only when nothing runs and nothing is outstanding", () => {
			expect(poolHasDrained({ running: [] })).toBe(true)
			expect(poolHasDrained({ running: [], hasUnfinishedEarlierWork: false })).toBe(true)
			expect(poolHasDrained({ running: [], hasUnfinishedEarlierWork: true })).toBe(false)
			expect(poolHasDrained({ running: [block({ dlineTid: "r", index: 0 })] })).toBe(false)
		})
	})
})
