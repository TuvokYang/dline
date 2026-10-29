import { describe, expect, it } from "vitest"
import * as retiredSettlement from "../NestedUsageSettlement"

describe("retired nested Usage settlement path", () => {
    it("exports no parallel settlement authority", () => {
        expect(Object.keys(retiredSettlement)).toEqual([])
    })
})
