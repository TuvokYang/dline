import { describe, expect, it } from "vitest"
import { areCompactionPassIdentitiesEqual, type CompactionPassIdentity } from "../target-window-fitting"

describe("compaction Pass identity comparison", () => {
	const identity: CompactionPassIdentity = {
		operationId: "operation-hidden-pass",
		passIndex: 2,
		passStartTurnIndex: 2,
		passEndTurnIndex: 3,
		coveredTurnCount: 2,
		summaryBaselineHash: "sha256:summary-baseline",
	}

	it("treats identities with identical fields in a different key order as equal", () => {
		const reordered: CompactionPassIdentity = {
			summaryBaselineHash: identity.summaryBaselineHash,
			coveredTurnCount: identity.coveredTurnCount,
			passEndTurnIndex: identity.passEndTurnIndex,
			passStartTurnIndex: identity.passStartTurnIndex,
			passIndex: identity.passIndex,
			operationId: identity.operationId,
		}
		expect(areCompactionPassIdentitiesEqual(identity, reordered)).toBe(true)
	})

	it("distinguishes identities that differ in any single field", () => {
		expect(areCompactionPassIdentitiesEqual(identity, { ...identity, passIndex: identity.passIndex + 1 })).toBe(false)
		expect(areCompactionPassIdentitiesEqual(identity, { ...identity, operationId: "other-operation" })).toBe(false)
		expect(areCompactionPassIdentitiesEqual(identity, { ...identity, coveredTurnCount: identity.coveredTurnCount + 1 })).toBe(
			false,
		)
		expect(areCompactionPassIdentitiesEqual(identity, { ...identity, summaryBaselineHash: "sha256:other-baseline" })).toBe(
			false,
		)
	})
})
