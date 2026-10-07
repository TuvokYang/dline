import "should"
import { wandbDefaultModelId, wandbModels } from "@shared/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { WandbHandler } from "../wandb"

describe("WandbHandler", () => {
	it("returns known catalog model metadata when model id is recognized", () => {
		const modelId = "meta-llama/Llama-3.3-70B-Instruct"
		const handler = new WandbHandler({
			profile: ApiProfile.create({ provider: "wandb", apiKey: "test-api-key", modelId }),
			mode: "act",
		})

		const model = handler.getModel()

		model.id.should.equal(modelId)
		model.info.should.deepEqual(wandbModels[modelId])
	})

	it("passes through an explicit unknown model id instead of silently falling back", () => {
		const unknownModelId = "moonshotai/Kimi-K2.5"
		const handler = new WandbHandler({
			profile: ApiProfile.create({ provider: "wandb", apiKey: "test-api-key", modelId: unknownModelId }),
			mode: "act",
		})

		const model = handler.getModel()

		model.id.should.equal(unknownModelId)
		model.info.should.deepEqual({ id: unknownModelId })
	})

	it("normalizes matching identities but does not relabel stale metadata", () => {
		const profile = ApiProfile.create({
			provider: "wandb",
			modelId: "  opaque-test  ",
			modelInfo: { id: " opaque-test ", name: "Effective", capabilities: { thinking: { supported: false } } },
		})
		const handler = new WandbHandler({ profile, mode: "act" })
		handler.getModel().should.deepEqual({ id: "opaque-test", info: { ...profile.modelInfo, id: "opaque-test" } })
		const stale = new WandbHandler({ profile: { ...profile, modelInfo: { id: "another-model" } }, mode: "act" })
		stale.getModel().should.deepEqual({ id: "opaque-test", info: { id: "opaque-test" } })
	})

	it("uses the default W&B model when no model id is configured", () => {
		const handler = new WandbHandler({
			profile: ApiProfile.create({ provider: "wandb", apiKey: "test-api-key" }),
			mode: "act",
		})

		const model = handler.getModel()

		model.id.should.equal(wandbDefaultModelId)
		model.info.should.deepEqual(wandbModels[wandbDefaultModelId])
	})
})
