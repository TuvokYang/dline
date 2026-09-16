import { describe, expect, it } from "vitest"
import { isKnownPerfPhase, PERF_PHASES, PerfDomain, perfDomains, perfEventName } from "./perf-domains"

/**
 * Parity guard for the migrated performance logs.
 *
 * `LEGACY_PHASES` is transcribed from the `phase=` values the original
 * `Logger.debug` templates emitted. If a migration drops a phase, or renames
 * one so historical series stop lining up, the corresponding assertion fails.
 */
const LEGACY_PHASES: Record<PerfDomain, readonly string[]> = {
	// [TerminalPerf] in CommandExecutor.ts and VscodeTerminalManager.ts
	[PerfDomain.Terminal]: [
		"execute_start",
		"terminal_acquired",
		"execute_complete",
		"execute_error",
		"process_start",
		"process_complete",
		"capability_failure",
		"shell_wait_start",
		"shell_wait_complete",
	],
	// [TerminalPerf] warm-pool phases in VscodeTerminalPoolRuntime.ts
	[PerfDomain.TerminalPool]: ["warm_process_started", "warm_shell_integration_ready", "prewarm_failed"],
	// [CheckpointPerf] in CheckpointGitOperations.ts
	[PerfDomain.Checkpoint]: ["existing_shadow_baseline", "add", "commit", "restore"],
	// [HookDiscoveryPerf] in hook-factory.ts and disk.ts
	[PerfDomain.HookDiscovery]: ["file_check", "has_hook_scan", "global_directory", "directories", "workspace_directories"],
	// [SettingsPerf] in controller/index.ts, StateManager.ts and updateSettings.ts
	[PerfDomain.Settings]: ["controller_callback", "sync_callback", "sync_broadcast", "state_flush", "rpc_complete", "rpc_error"],
	// [SettingsRepositoryPerf] in SettingsRepository.ts
	[PerfDomain.SettingsRepository]: ["mutate_complete", "reconcile", "listener", "publish"],
	// [TaskInitPerf] in controller/index.ts
	[PerfDomain.TaskInit]: ["stage"],
	// [TaskClosePerf] in task/index.ts
	[PerfDomain.TaskClose]: ["stage"],
	// [TaskSnapshotPerf] in TaskSnapshotPersistence.ts
	[PerfDomain.TaskSnapshot]: ["flush_now"],
	// New in BufferedUnifyStore.ts; no legacy log preceded it, which is why a
	// commit that rewrote the whole collection stayed invisible until it was
	// measured by hand.
	[PerfDomain.BufferedStore]: ["flush_commit"],
	// New in ToolExecutor.ts; the pre-existing `tool.execution` span records the
	// same boundary but only as a trace, so a slow tool could not be queried or
	// alerted on as a metric.
	[PerfDomain.Tool]: ["execution"],
	// [ControllerClosePerf] in controller/index.ts
	[PerfDomain.ControllerClose]: ["stage"],
	// [ProfilePerf] in ProfileCatalogRepository.ts and getApiProfiles.ts
	[PerfDomain.Profile]: ["catalog_initialize", "catalog_mutate", "catalog_reconcile", "get_profiles"],
	// [CapabilityPerf] in workflows.ts, skills.ts, rule-helpers.ts, external-rules.ts,
	// refreshSubagents.ts, refreshSkills.ts and refreshRules.ts
	[PerfDomain.Capability]: [
		"workflows_refresh",
		"skills_discover",
		"skills_available",
		"skills_refresh",
		"subagents_refresh",
		"subagents_refresh_error",
		"rules_refresh_rpc",
		"rules_refresh_rpc_error",
		"rule_toggle_scan",
		"external_rules_refresh",
	],
	// [PromptInputWatcherPerf] in PromptInputFileWatcher.ts
	[PerfDomain.PromptInputWatcher]: ["start", "ready", "dispose", "event_batch"],
	// [PromptFreshnessPerf] in PromptFreshnessInvalidationCoordinator.ts and task/index.ts
	[PerfDomain.PromptFreshness]: ["drain_complete", "reevaluate"],
	// [PromptBuildPerf] in task/index.ts
	[PerfDomain.PromptBuild]: ["capability_context"],
	// [FileLockPerf] in FileLock.ts
	[PerfDomain.FileLock]: ["acquire"],
	// Activation timings previously logged without a [*Perf] prefix
	[PerfDomain.Activation]: ["stage", "extension_activate", "common_initialize"],
}

describe("perf domain catalogue", () => {
	it("declares every domain that carried a legacy perf log", () => {
		expect(new Set(perfDomains())).toEqual(new Set(Object.keys(LEGACY_PHASES)))
	})

	it.each(Object.keys(LEGACY_PHASES) as PerfDomain[])("keeps every legacy phase for %s", (domain) => {
		const declared = new Set(PERF_PHASES[domain] as readonly string[])
		for (const phase of LEGACY_PHASES[domain]) {
			expect(declared.has(phase), `${domain} lost phase ${phase}`).toBe(true)
		}
	})

	it("declares no phase twice within a domain", () => {
		for (const domain of perfDomains()) {
			const phases = PERF_PHASES[domain] as readonly string[]
			expect(new Set(phases).size, `${domain} declares a duplicate phase`).toBe(phases.length)
		}
	})

	it("builds a dotted event name from the domain and phase", () => {
		expect(perfEventName(PerfDomain.Terminal, "execute_complete")).toBe("terminal.execute_complete")
		expect(perfEventName(PerfDomain.PromptInputWatcher, "event_batch")).toBe("prompt_input_watcher.event_batch")
	})

	it("produces a unique event name for every declared phase", () => {
		const names = perfDomains().flatMap((domain) =>
			(PERF_PHASES[domain] as readonly string[]).map((phase) => `${domain}.${phase}`),
		)
		expect(new Set(names).size).toBe(names.length)
	})

	it("recognizes declared phases and rejects undeclared ones", () => {
		expect(isKnownPerfPhase(PerfDomain.FileLock, "acquire")).toBe(true)
		expect(isKnownPerfPhase(PerfDomain.FileLock, "release")).toBe(false)
	})
})
