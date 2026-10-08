import { randomUUID } from "node:crypto"
import type { SubagentExecResult } from "./SubagentExecutor"

export type SubagentJobStatus = "running" | "completed" | "failed" | "timeout" | "cancelled"
export type SubagentJobRunner = () => Promise<SubagentExecResult>

export type SubagentJobListener = (job: SubagentJobRecord, batch?: SubagentBatchRecord) => void | Promise<void>

export interface StartSubagentJobInput {
	subagentName?: string
	task: string
	prompt: string
	timeoutSeconds: number
	runner: SubagentJobRunner
	onCreated?: (job: SubagentJobRecord) => void
	onStatusChange?: SubagentJobListener
}

export interface StartSubagentBatchItemInput {
	subagentName?: string
	task: string
	prompt: string
	runner: SubagentJobRunner
}

export interface StartSubagentBatchInput {
	timeoutSeconds: number
	items: StartSubagentBatchItemInput[]
	onStatusChange?: SubagentJobListener
	onCreated?: (batch: SubagentBatchRecord) => void
}

export interface RetainRetryableSubagentJobInput {
	jobId: string
	subagentName?: string
	task: string
	prompt: string
	timeoutSeconds: number
	startedAt: number
	result: SubagentExecResult
	runner: SubagentJobRunner
	onStatusChange?: SubagentJobListener
}

export interface SubagentJobRecord {
	jobId: string
	batchJobId?: string
	subagentName?: string
	task: string
	prompt: string
	status: SubagentJobStatus
	startedAt: number
	finishedAt?: number
	timeoutSeconds: number
	result?: string
	error?: string
	stats?: SubagentExecResult["stats"]
	retryable?: boolean
	attempt: number
}

export interface SubagentBatchRecord {
	batchJobId: string
	status: SubagentJobStatus
	startedAt: number
	finishedAt?: number
	timeoutSeconds: number
	itemJobIds: string[]
}

export type SubagentInjectableResult =
	| { kind: "single"; job: SubagentJobRecord }
	| { kind: "batch"; batch: SubagentBatchRecord; jobs: SubagentJobRecord[] }

/** Manage task-local background subagent jobs and batches. */
export class SubagentJobManager {
	private jobs = new Map<string, SubagentJobRecord>()
	private batches = new Map<string, SubagentBatchRecord>()
	private runners = new Map<string, SubagentJobRunner>()
	private listeners = new Map<string, SubagentJobListener>()

	/**
	 * Start one background subagent job.
	 * @param input Job metadata and runner callback.
	 * @returns Created running job record.
	 */
	startJob(input: StartSubagentJobInput): SubagentJobRecord {
		const job = this.createJob(input)
		input.onCreated?.({ ...job })
		void this.runJob(job.jobId, input.runner, undefined, input.onStatusChange)
		return job
	}

	/**
	 * Start a background batch with one job per item.
	 * @param input Batch metadata and item runners.
	 * @returns Created running batch record.
	 */
	startBatch(input: StartSubagentBatchInput): SubagentBatchRecord {
		const batchJobId = this.nextBatchId()
		const itemJobIds: string[] = []
		const batch: SubagentBatchRecord = {
			batchJobId,
			status: "running",
			startedAt: Date.now(),
			timeoutSeconds: input.timeoutSeconds,
			itemJobIds,
		}
		this.batches.set(batchJobId, batch)
		const runners: Array<{ jobId: string; runner: SubagentJobRunner }> = []
		for (const item of input.items) {
			const job = this.createJob(
				{ ...item, timeoutSeconds: input.timeoutSeconds, onStatusChange: input.onStatusChange },
				batchJobId,
			)
			batch.itemJobIds.push(job.jobId)
			runners.push({ jobId: job.jobId, runner: item.runner })
		}
		input.onCreated?.({ ...batch, itemJobIds: [...batch.itemJobIds] })
		for (const item of runners) {
			void this.runJob(item.jobId, item.runner, batchJobId, input.onStatusChange)
		}
		return { ...batch, itemJobIds: [...batch.itemJobIds] }
	}

	/**
	 * Get one job record by id.
	 * @param jobId Job id to read.
	 * @returns Job record copy, or undefined.
	 */
	getJob(jobId: string): SubagentJobRecord | undefined {
		const job = this.jobs.get(jobId)
		return job ? { ...job } : undefined
	}

	/**
	 * Get one batch record by id.
	 * @param batchJobId Batch id to read.
	 * @returns Batch record copy, or undefined.
	 */
	getBatch(batchJobId: string): SubagentBatchRecord | undefined {
		const batch = this.batches.get(batchJobId)
		return batch ? { ...batch, itemJobIds: [...batch.itemJobIds] } : undefined
	}

	/**
	 * List all tracked jobs.
	 * @returns Job record copies.
	 */
	listJobs(): SubagentJobRecord[] {
		return Array.from(this.jobs.values()).map((job) => ({ ...job }))
	}

	/**
	 * List all tracked batches.
	 * @returns Batch record copies.
	 */
	listBatches(): SubagentBatchRecord[] {
		return Array.from(this.batches.values()).map((batch) => ({ ...batch, itemJobIds: [...batch.itemJobIds] }))
	}

	retainRetryableJob(input: RetainRetryableSubagentJobInput): SubagentJobRecord {
		const existing = this.jobs.get(input.jobId)
		if (existing) return { ...existing }
		const isRecoverableStatus = input.result.status === "failed" || input.result.status === "cancelled"
		if (!isRecoverableStatus || input.result.retryable !== true) {
			throw new Error("Only retryable failed or cancelled subagent results can be retained.")
		}
		const job: SubagentJobRecord = {
			jobId: input.jobId,
			subagentName: input.subagentName,
			task: input.task,
			prompt: input.prompt,
			status: input.result.status === "cancelled" ? "cancelled" : "failed",
			startedAt: input.startedAt,
			finishedAt: Date.now(),
			timeoutSeconds: input.timeoutSeconds,
			error: input.result.error,
			stats: input.result.stats,
			retryable: true,
			attempt: 1,
		}
		this.jobs.set(job.jobId, job)
		this.runners.set(job.jobId, input.runner)
		if (input.onStatusChange) this.listeners.set(job.jobId, input.onStatusChange)
		return { ...job }
	}

	async retryJob(jobId: string): Promise<boolean> {
		const job = this.jobs.get(jobId)
		const runner = this.runners.get(jobId)
		// Both a provider failure and a user cancellation are recoverable entry points.
		const isRecoverableStatus = job?.status === "failed" || job?.status === "cancelled"
		if (!job || !runner || !isRecoverableStatus || !job.retryable) return false
		job.status = "running"
		job.startedAt = Date.now()
		job.finishedAt = undefined
		job.result = undefined
		job.error = undefined
		job.stats = undefined
		job.retryable = false
		job.attempt += 1
		if (job.batchJobId) {
			const batch = this.batches.get(job.batchJobId)
			if (batch) {
				batch.status = "running"
				batch.finishedAt = undefined
			}
		}
		void this.runJob(jobId, runner, job.batchJobId, this.listeners.get(jobId))
		return true
	}

	/**
	 * Create a job record without waiting for the runner.
	 * @param input Job metadata.
	 * @param batchJobId Optional parent batch id.
	 * @returns Created running job record.
	 */
	private createJob(input: StartSubagentJobInput, batchJobId?: string): SubagentJobRecord {
		const job: SubagentJobRecord = {
			jobId: this.nextJobId(),
			batchJobId,
			subagentName: input.subagentName,
			task: input.task,
			prompt: input.prompt,
			status: "running",
			startedAt: Date.now(),
			timeoutSeconds: input.timeoutSeconds,
			attempt: 1,
		}
		this.jobs.set(job.jobId, job)
		this.runners.set(job.jobId, input.runner)
		if (input.onStatusChange) this.listeners.set(job.jobId, input.onStatusChange)
		return { ...job }
	}

	/**
	 * Run a job and persist its final status.
	 * @param jobId Job id to update.
	 * @param runner Runner callback.
	 * @param batchJobId Optional parent batch id.
	 */
	private async runJob(
		jobId: string,
		runner: SubagentJobRunner,
		batchJobId?: string,
		onStatusChange?: SubagentJobListener,
	): Promise<void> {
		try {
			this.finishJob(jobId, await runner())
		} catch (error) {
			this.failJob(jobId, error)
		} finally {
			if (batchJobId) this.refreshBatch(batchJobId)
			const job = this.jobs.get(jobId)
			const batch = batchJobId ? this.batches.get(batchJobId) : undefined
			if (job && onStatusChange)
				void onStatusChange({ ...job }, batch ? { ...batch, itemJobIds: [...batch.itemJobIds] } : undefined)
		}
	}

	/**
	 * Persist a completed job result.
	 * @param jobId Job id to update.
	 * @param result Runner result.
	 */
	private finishJob(jobId: string, result: SubagentExecResult): void {
		const job = this.jobs.get(jobId)
		if (!job) return
		job.status =
			result.status === "completed"
				? "completed"
				: result.status === "timeout"
					? "timeout"
					: result.status === "cancelled"
						? "cancelled"
						: "failed"
		job.finishedAt = Date.now()
		job.result = result.result
		job.error = result.error
		job.stats = result.stats
		// A cancelled run is recoverable too: the user stopped it deliberately and
		// must be able to restart it from the Activity panel.
		job.retryable = (result.status === "failed" || result.status === "cancelled") && result.retryable === true
	}

	/**
	 * Persist a failed job result.
	 * @param jobId Job id to update.
	 * @param error Unknown runner error.
	 */
	private failJob(jobId: string, error: unknown): void {
		const job = this.jobs.get(jobId)
		if (!job) return
		job.status = "failed"
		job.finishedAt = Date.now()
		job.error = error instanceof Error ? error.message : String(error)
		job.retryable = false
	}

	/**
	 * Refresh aggregate batch status from item jobs.
	 * @param batchJobId Batch id to update.
	 */
	private refreshBatch(batchJobId: string): void {
		const batch = this.batches.get(batchJobId)
		if (!batch) return
		const jobs = batch.itemJobIds.map((jobId) => this.jobs.get(jobId)).filter((job): job is SubagentJobRecord => !!job)
		if (jobs.some((job) => job.status === "running")) {
			batch.status = "running"
			return
		}
		batch.finishedAt = Date.now()
		if (jobs.some((job) => job.status === "timeout")) batch.status = "timeout"
		else if (jobs.some((job) => job.status === "failed")) batch.status = "failed"
		else if (jobs.some((job) => job.status === "cancelled")) batch.status = "cancelled"
		else batch.status = "completed"
	}

	/** Build a process-independent job id. */
	private nextJobId(): string {
		return `subagent_${randomUUID()}`
	}

	/** Build a process-independent batch id. */
	private nextBatchId(): string {
		return `subagent_batch_${randomUUID()}`
	}
}
