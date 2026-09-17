/**
 * Terminal Constants
 *
 * Central location for all terminal-related constants.
 * This makes it easy to understand and tune terminal behavior.
 */

// =============================================================================
// Process "Hot" State Timeouts
// =============================================================================
// How long to wait after output before considering the process "cool"
// This stalls API requests to let terminal output settle

/** Normal timeout after last output (2 seconds) */
export const PROCESS_HOT_TIMEOUT_NORMAL = 2_000

/** Extended timeout for compilation/build commands (15 seconds) */
export const PROCESS_HOT_TIMEOUT_COMPILING = 15_000

// =============================================================================
// Output Buffering (CommandOrchestrator)
// =============================================================================
// Controls how output is chunked and sent to the UI

/** Visual frame interval for coalescing terminal output (approximately 50 FPS). */
export const TERMINAL_OUTPUT_FRAME_INTERVAL_MS = 20

/** Maximum entries admitted to one terminal output frame before an early flush. */
export const TERMINAL_OUTPUT_FRAME_MAX_LINES = 256

/** Maximum UTF-8 payload admitted to one terminal output frame before an early flush. */
export const TERMINAL_OUTPUT_FRAME_MAX_BYTES = 32 * 1024

/** Pause or gate terminal producers when the pending frame buffer reaches this size. */
export const TERMINAL_OUTPUT_PENDING_HIGH_WATER_BYTES = 128 * 1024

/** Resume terminal producers after the pending frame buffer drains below this size. */
export const TERMINAL_OUTPUT_PENDING_LOW_WATER_BYTES = 32 * 1024

/** Timeout to detect stuck completion */
export const COMPLETION_TIMEOUT_MS = 6000 // 6 seconds

// =============================================================================
// Large Output Protection
// =============================================================================
// Prevents memory exhaustion and context window overflow

/** Switch to file-based logging after this many lines */
export const MAX_LINES_BEFORE_FILE = 1000

/** Switch to file-based logging after this many bytes */
export const MAX_BYTES_BEFORE_FILE = 512 * 1024 // 512KB

/** Lines to keep at start/end for summary when truncating */
export const SUMMARY_LINES_TO_KEEP = 100

/** Maximum size for fullOutput storage (memory protection) */
export const MAX_FULL_OUTPUT_SIZE = 1024 * 1024 // 1MB

/** Maximum lines to return from getUnretrievedOutput */
export const MAX_UNRETRIEVED_LINES = 500

/** Lines to keep at start/end when truncating unretrieved output */
export const TRUNCATE_KEEP_LINES = 100

// =============================================================================
// Output Line Limits (processOutput)
// =============================================================================
// Controls truncation when returning output to AI

/** Default max lines for command output */
export const DEFAULT_TERMINAL_OUTPUT_LINE_LIMIT = 500

// =============================================================================
// Background Command Tracking
// =============================================================================
// Controls background command behavior for "Proceed While Running"

/** Foreground grace period before a non-synchronous command is handed to background tracking. */
export const COMMAND_BACKGROUND_HANDOFF_MS = 10_000

/**
 * Bounded wait for a background log stream to finish flushing.
 *
 * Disposal awaits this flush, so an unbounded wait would turn a stuck write
 * stream into a stuck task teardown. Exceeding the budget is reported as a log
 * failure rather than silently dropping the wait.
 */
export const LOG_STREAM_FINALIZE_TIMEOUT_MS = 5_000

// =============================================================================
// Compilation Detection Markers
// =============================================================================
// Used to detect if a command is compiling/building

/** Markers that indicate compilation is starting */
export const COMPILING_MARKERS = ["compiling", "building", "bundling", "transpiling", "generating", "starting"]

/** Markers that indicate compilation is done (nullify extended timeout) */
export const COMPILING_NULLIFIERS = [
	"compiled",
	"success",
	"finish",
	"complete",
	"succeed",
	"done",
	"end",
	"stop",
	"exit",
	"terminate",
	"error",
	"fail",
]

/**
 * Check if terminal output indicates compilation/building.
 * Matches markers anywhere in the output.
 */
export function isCompilingOutput(data: string): boolean {
	const lowerData = data.toLowerCase()
	const hasMarker = COMPILING_MARKERS.some((marker) => lowerData.includes(marker.toLowerCase()))
	const hasNullifier = COMPILING_NULLIFIERS.some((nullifier) => lowerData.includes(nullifier.toLowerCase()))
	return hasMarker && !hasNullifier
}
