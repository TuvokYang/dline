import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ApiMetrics } from "@shared/getApiMetrics"
import { MessageUsageProjection } from "./MessageUsageProjection"

export type TaskUsageMessages = () => ClineMessage[]

export interface TaskUsageReader {
	readStateMetrics(messages: TaskUsageMessages, revision: number): ApiMetrics
	readHistoryMetrics(messages: TaskUsageMessages, revision: number): ApiMetrics
}

/** Compatibility for legacy message facts; both caches belong to the metrics module. */
export class LegacyMessageUsageReader implements TaskUsageReader {
	private readonly projection = new MessageUsageProjection()
	private state?: { revision: number; metrics: ApiMetrics }
	private history?: { revision: number; metrics: ApiMetrics }

	readStateMetrics(messages: TaskUsageMessages, revision: number): ApiMetrics {
		if (this.state?.revision === revision) return this.state.metrics
		const metrics = this.projection.read(messages())
		this.state = { revision, metrics }
		return metrics
	}

	readHistoryMetrics(messages: TaskUsageMessages, revision: number): ApiMetrics {
		if (this.history?.revision === revision) return this.history.metrics
		const metrics = this.projection.read(messages().slice(1))
		this.history = { revision, metrics }
		return metrics
	}
}
