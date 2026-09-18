import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import type { AgentBaseConfig } from "../AgentConfigLoader"
import { planSubagentBatch, type SubagentBatchResolvers, subagentJobId } from "../SubagentBatchPlanner"
import type { SubagentBatchItemRequest } from "../SubagentRequestParser"

function agentConfig(name: string, profile?: string): AgentBaseConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `You are ${name}.`,
		...(profile ? { profile } : {}),
	} as AgentBaseConfig
}

function item(overrides: Partial<SubagentBatchItemRequest> & { index: number }): SubagentBatchItemRequest {
	const task = overrides.task ?? `task ${overrides.index}`
	const context = overrides.context ?? `ctx ${overrides.index}`
	return {
		agentName: "default",
		task,
		context,
		prompt: `<task>\n${task}\n</task>\n<context>\n${context}\n</context>`,
		...overrides,
	}
}

function resolvers(overrides: Partial<SubagentBatchResolvers> = {}): SubagentBatchResolvers {
	return {
		resolveAgent: async (name) => (name === "default" ? undefined : agentConfig(name)),
		isProfileUsable: () => true,
		listAgentNames: async () => ["default", "reviewer"],
		...overrides,
	}
}

describe("planSubagentBatch", () => {
	describe("identity", () => {
		it("assigns a stable job id per item derived from the batch", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1 }), item({ index: 2 })],
				batchTimeoutSeconds: 600,
				batchId: "batch_a",
				resolvers: resolvers(),
			})

			assert.deepEqual(
				plan.planned.map((planned) => planned.jobId),
				["batch_a_1", "batch_a_2"],
			)
			assert.equal(subagentJobId("batch_a", 2), "batch_a_2")
		})

		it("keeps ids addressable when a middle item is rejected", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1 }), item({ index: 2, agentName: "ghost" }), item({ index: 3 })],
				batchTimeoutSeconds: 600,
				batchId: "batch_b",
				resolvers: resolvers({ resolveAgent: async (name) => (name === "ghost" ? undefined : agentConfig(name)) }),
			})

			// The executing set is sparse, so array position is not identity: the
			// third item must still be addressable as item 3.
			assert.deepEqual(
				plan.planned.map((planned) => planned.jobId),
				["batch_b_1", "batch_b_3"],
			)
			assert.deepEqual(
				plan.rejected.map((rejected) => rejected.jobId),
				["batch_b_2"],
			)
			assert.equal(plan.planned[1].index, 3)
		})
	})

	describe("per-item resolution", () => {
		it("resolves each item against its own agent", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "reviewer" }), item({ index: 2, agentName: "default" })],
				batchTimeoutSeconds: 600,
				batchId: "batch_c",
				resolvers: resolvers(),
			})

			assert.equal(plan.planned[0].subagentName, "reviewer")
			assert.equal(plan.planned[0].agentConfig?.name, "reviewer")
			assert.equal(plan.planned[1].subagentName, "default")
			assert.equal(plan.planned[1].agentConfig, undefined)
		})

		it("lets an explicit item profile win over the agent's configured profile", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "reviewer", profile: "gpt" }), item({ index: 2, agentName: "reviewer" })],
				batchTimeoutSeconds: 600,
				batchId: "batch_d",
				resolvers: resolvers({ resolveAgent: async (name) => agentConfig(name, "yaml-profile") }),
			})

			assert.equal(plan.planned[0].profileName, "gpt")
			assert.equal(plan.planned[0].agentConfig?.profile, "gpt")
			assert.equal(plan.planned[1].profileName, "yaml-profile")
			assert.equal(plan.planned[1].agentConfig?.profile, "yaml-profile")
		})

		it("carries an explicit profile for the built-in default subagent", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "default", profile: "gpt" })],
				batchTimeoutSeconds: 600,
				batchId: "batch_e",
				resolvers: resolvers(),
			})

			assert.equal(plan.planned[0].subagentName, "default")
			assert.equal(plan.planned[0].agentConfig?.profile, "gpt")
			assert.equal(plan.planned[0].profileName, "gpt")
		})

		it("leaves resolution to the builder when no profile is requested anywhere", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "reviewer" })],
				batchTimeoutSeconds: 600,
				batchId: "batch_f",
				resolvers: resolvers(),
			})

			assert.equal(plan.planned[0].profileName, undefined)
			assert.equal(plan.planned[0].agentConfig?.profile, undefined)
		})
	})

	describe("fail-closed handling", () => {
		it("fails the item instead of falling back when an explicit profile is unusable", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "reviewer", profile: "retired" }), item({ index: 2 })],
				batchTimeoutSeconds: 600,
				batchId: "batch_g",
				resolvers: resolvers({ isProfileUsable: (profile) => profile !== "retired" }),
			})

			assert.equal(plan.planned.length, 1)
			assert.equal(plan.planned[0].index, 2)
			assert.equal(plan.rejected.length, 1)
			assert.match(plan.rejected[0].error, /API Profile 'retired' is unavailable or not enabled for subagents/)
			assert.match(plan.rejected[0].error, /omit the profile field/)
		})

		it("reports an unknown agent with the names that were selectable", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "ghost" })],
				batchTimeoutSeconds: 600,
				batchId: "batch_h",
				resolvers: resolvers({ resolveAgent: async () => undefined }),
			})

			assert.equal(plan.planned.length, 0)
			assert.match(plan.rejected[0].error, /Unknown or disabled subagent 'ghost'/)
			assert.match(plan.rejected[0].error, /Available subagents: default, reviewer/)
			assert.equal(plan.rejected[0].requestedName, "ghost")
		})

		it("keeps one bad item from cancelling the rest of the batch", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1 }), item({ index: 2, agentName: "ghost" }), item({ index: 3 })],
				batchTimeoutSeconds: 600,
				batchId: "batch_i",
				resolvers: resolvers({ resolveAgent: async (name) => (name === "ghost" ? undefined : agentConfig(name)) }),
			})

			assert.equal(plan.planned.length, 2)
			assert.equal(plan.rejected.length, 1)
		})
	})

	describe("timeouts", () => {
		it("inherits the batch timeout and honours a per-item override", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1 }), item({ index: 2, timeoutSeconds: 90 })],
				batchTimeoutSeconds: 600,
				batchId: "batch_j",
				resolvers: resolvers(),
			})

			assert.equal(plan.planned[0].timeoutSeconds, 600)
			assert.equal(plan.planned[1].timeoutSeconds, 90)
		})

		it("records the effective timeout on a rejected item too", async () => {
			const plan = await planSubagentBatch({
				items: [item({ index: 1, agentName: "ghost", timeoutSeconds: 45 })],
				batchTimeoutSeconds: 600,
				batchId: "batch_k",
				resolvers: resolvers({ resolveAgent: async () => undefined }),
			})

			assert.equal(plan.rejected[0].timeoutSeconds, 45)
		})
	})
})
