import { describe, expect, it } from "vitest"
import * as retiredAutoApprove from "../autoApprove"

describe("retired AutoApprove compatibility module", () => {
	it("exports no approval authority", () => {
		expect(Object.keys(retiredAutoApprove)).toEqual([])
	})
})
