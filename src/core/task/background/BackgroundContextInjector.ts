import type { BackgroundCommand } from "@integrations/terminal"
import type { SubagentInjectableResult, SubagentJobManager, SubagentJobRecord } from "../tools/subagent/SubagentJobManager"

export interface BackgroundCommandProvider {
	listBackgroundCommands(): BackgroundCommand[]
}

export interface BackgroundContextInjectorOptions {
	subagentJobManager: SubagentJobManager
	commandProvider?: BackgroundCommandProvider
}

export interface BackgroundEnvironmentSection {
	text: string
	commandLineCounts: Array<{ id: string; lineCount: number }>
}

export interface BackgroundSubagentProvider {
	getSubagentJobManager(): SubagentJobManager
}

export function formatBackgroundCommandResult(command: BackgroundCommand): string {
	const exitCode = command.exitCode ?? "unavailable"
	const lineLabel = command.lineCount === 1 ? "output line" : "output lines"
	const logFilePath = command.logFilePath ?? "unavailable"
	return `- ${command.id}: ${command.status} - ${command.command}\n  Exit code: ${exitCode}; ${command.lineCount} ${lineLabel}; log: ${logFilePath}`
}

export function formatBackgroundSubagentResult(job: SubagentJobRecord): string {
	const task = job.task || job.subagentName || job.prompt
	const detail = job.result || job.error || "No result content."
	return `- ${job.jobId}: ${job.status} — ${task}\n  ${detail}`
}

export function formatBackgroundSubagentDelivery(result: SubagentInjectableResult): string {
	if (result.kind === "single") {
		return ["# Background Results", "## Background Subagent Results", formatBackgroundSubagentResult(result.job)].join("\n")
	}
	return [
		"# Background Results",
		"## Background Subagent Results",
		`- ${result.batch.batchJobId}: ${result.batch.status}`,
		...result.jobs.map((job) => `  ${formatBackgroundSubagentResult(job)}`),
	].join("\n")
}

/**
 * Build a task-local background section for environment details.
 * @param subagentProvider Provider exposing the task-local subagent job manager.
 * @param commandProvider Provider exposing task-local background commands.
 * @returns Markdown sections, or an empty string when no background work is visible.
 */
export function buildTaskBackgroundSection(
	subagentProvider: BackgroundSubagentProvider,
	commandProvider?: BackgroundCommandProvider,
): string {
	return buildTaskBackgroundEnvironmentSection(subagentProvider, commandProvider).text
}

/** Build Environment metadata together with the exact command line-count snapshot it represents. */
export function buildTaskBackgroundEnvironmentSection(
	subagentProvider: BackgroundSubagentProvider,
	commandProvider?: BackgroundCommandProvider,
): BackgroundEnvironmentSection {
	const injector = new BackgroundContextInjector({
		subagentJobManager: subagentProvider.getSubagentJobManager(),
		commandProvider,
	})
	return injector.buildEnvironmentSectionWithMetadata()
}

/**
 * Formats running task-local background subagent and command state for environment context.
 */
export class BackgroundContextInjector {
	private readonly subagentJobManager: SubagentJobManager
	private readonly commandProvider?: BackgroundCommandProvider

	/**
	 * Create a background context injector.
	 * @param options Task-local background state providers.
	 */
	constructor(options: BackgroundContextInjectorOptions) {
		this.subagentJobManager = options.subagentJobManager
		this.commandProvider = options.commandProvider
	}

	/**
	 * Build environment_details sections for currently running background work.
	 * @returns Markdown sections, or an empty string when no background work is running.
	 */
	buildEnvironmentSection(): string {
		return this.buildEnvironmentSectionWithMetadata().text
	}

	/** Build Environment text and capture the exact output counts described by that text. */
	buildEnvironmentSectionWithMetadata(): BackgroundEnvironmentSection {
		const commands = this.listVisibleCommands()
		const sections = [this.buildSubagentSection(), this.buildCommandSection(commands)].filter((section) => section.length > 0)
		return {
			text: sections.join("\n\n"),
			commandLineCounts: commands.map((command) => ({ id: command.id, lineCount: command.lineCount })),
		}
	}

	/**
	 * Build the running background subagent environment section.
	 * @returns Markdown section for visible subagent jobs.
	 */
	private buildSubagentSection(): string {
		const jobs = this.subagentJobManager.listJobs().filter((job) => job.status === "running")
		if (jobs.length === 0) return ""
		return ["# Background Subagents", ...jobs.map((job) => this.formatSubagent(job))].join("\n")
	}

	/**
	 * Format one subagent job for environment details.
	 * @param job Job record to format.
	 * @returns One markdown list item.
	 */
	private formatSubagent(job: SubagentJobRecord): string {
		const task = job.task || job.subagentName || job.prompt
		return `- ${job.jobId}: ${job.status} — ${task}`
	}

	/**
	 * Build the running background command environment section.
	 * @returns Markdown section for visible background commands.
	 */
	private listVisibleCommands(): BackgroundCommand[] {
		return this.commandProvider?.listBackgroundCommands().filter((command) => command.status === "running") ?? []
	}

	private buildCommandSection(commands: BackgroundCommand[]): string {
		if (commands.length === 0) return ""
		return ["# Background Commands", ...commands.map((command) => this.formatCommand(command))].join("\n")
	}

	/**
	 * Format one background command for environment details.
	 * @param command Background command to format.
	 * @returns One markdown list item.
	 */
	private formatCommand(command: BackgroundCommand): string {
		const outputChange = Math.max(0, command.lineCount - (command.lastApiSentLineCount ?? 0))
		const lineLabel = outputChange === 1 ? "line" : "lines"
		return [
			`- function_id: ${command.functionId ?? "unavailable"}`,
			`  status: ${command.status}`,
			`  output change since last API send: +${outputChange} ${lineLabel}`,
			`  command: ${command.command}`,
			`  log: ${command.logFilePath ?? "unavailable"}`,
		].join("\n")
	}
}
