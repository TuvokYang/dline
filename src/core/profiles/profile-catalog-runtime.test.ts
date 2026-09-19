import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import { handleExternalProfileCatalogCommit } from "./profile-catalog-runtime"

function profile(id: string, provider: string): ApiProfile {
	return ApiProfile.create({ id, provider, name: id, modelId: "model-a", enabled: true })
}

describe("handleExternalProfileCatalogCommit", () => {
	it("invalidates removed Codex OAuth ownership before broadcasting an external Catalog commit", async () => {
		const order: string[] = []
		const previous = [profile("codex-a", "openai-codex")]
		const profiles: ApiProfile[] = []
		const reconcile = vi.fn(async () => {
			order.push("reconcile")
		})
		const publish = vi.fn(async () => {
			order.push("publish")
		})

		await handleExternalProfileCatalogCommit(previous, profiles, {
			invalidateReadCache: () => order.push("invalidate"),
			advanceRevision: () => order.push("advance"),
			reconcile,
			publish,
		})

		expect(order).toEqual(["invalidate", "advance", "reconcile", "publish"])
		expect(reconcile).toHaveBeenCalledWith(previous, profiles)
		expect(publish).toHaveBeenCalledWith(previous, profiles)
	})
})
