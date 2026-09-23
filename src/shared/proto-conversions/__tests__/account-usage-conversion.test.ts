import type { AccountUsage as ProtoAccountUsage } from "@shared/proto/dline/state"
import { describe, expect, it } from "vitest"
import { accountUsageToProto, protoToAccountUsage } from "../account-usage-conversion"

/**
 * Build a proto payload the way a provider without reset-credit support produces
 * it: `accountUsageToProto` never omits the fields, so the repeated field is `[]`
 * and the count is `undefined` before transport. Decoding a real envelope turns
 * the count into `0`, which is the case these tests pin down.
 */
function protoUsage(overrides: Partial<ProtoAccountUsage> = {}): ProtoAccountUsage {
	return {
		profileId: "profile-a",
		providerId: "anthropic",
		currency: "USD",
		quotas: [],
		resetCredits: [],
		resetCreditsAvailableCount: 0,
		...overrides,
	} as ProtoAccountUsage
}

describe("account usage reset-credit presence", () => {
	it("reports no reset-credit capability when the provider sends the empty encoding", () => {
		const usage = protoToAccountUsage(protoUsage())

		// The UI treats `undefined` as "this provider has no reset cards" and hides
		// the whole section. Proto3 cannot express that, so the conversion must.
		expect(usage?.resetCredits).toBeUndefined()
		expect(usage?.resetCreditsAvailableCount).toBeUndefined()
	})

	it("keeps a positive available count even when the credit list is not itemised", () => {
		const usage = protoToAccountUsage(protoUsage({ resetCreditsAvailableCount: 2 }))

		expect(usage?.resetCreditsAvailableCount).toBe(2)
	})

	it("keeps an itemised credit list even when the count is absent", () => {
		const usage = protoToAccountUsage(
			protoUsage({ resetCredits: [{ id: "credit-a", expiresAt: "2030-03-25T00:00:00.000Z" }] as never }),
		)

		expect(usage?.resetCredits).toEqual([{ id: "credit-a", grantedAt: undefined, expiresAt: "2030-03-25T00:00:00.000Z" }])
	})

	it("drops credit entries that carry no identity", () => {
		const usage = protoToAccountUsage(
			protoUsage({ resetCredits: [{ id: "" }, { id: "credit-b" }] as never, resetCreditsAvailableCount: 1 }),
		)

		expect(usage?.resetCredits?.map((credit) => credit.id)).toEqual(["credit-b"])
	})

	it("round-trips a supported provider without inventing or losing capability", () => {
		const decoded = protoToAccountUsage(
			protoUsage({ resetCredits: [{ id: "credit-a" }] as never, resetCreditsAvailableCount: 1 }),
		)
		const reencoded = accountUsageToProto(decoded)

		expect(reencoded?.resetCreditsAvailableCount).toBe(1)
		expect(reencoded?.resetCredits).toHaveLength(1)
		expect(protoToAccountUsage(reencoded)?.resetCreditsAvailableCount).toBe(1)
	})

	it("keeps an unsupported provider unsupported across a full round trip", () => {
		const reencoded = accountUsageToProto(protoToAccountUsage(protoUsage()))

		// A round trip must not promote the empty encoding into a visible section.
		expect(protoToAccountUsage(reencoded)?.resetCreditsAvailableCount).toBeUndefined()
	})
})
