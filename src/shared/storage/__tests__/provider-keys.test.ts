import { moonshotDefaultModelId } from "@shared/api"
import { expect } from "chai"
import { describe, it } from "vitest"
import { getProviderDefaultModelId } from "../provider-keys"

describe("Provider key mapping", () => {
	it("returns Moonshot default model ID", () => {
		expect(getProviderDefaultModelId("moonshot")).to.equal(moonshotDefaultModelId)
	})
})
