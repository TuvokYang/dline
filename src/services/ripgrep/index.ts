import type { IgnoreController } from "@core/ignore/IgnoreController"
import * as childProcess from "child_process"
import * as path from "path"
import * as readline from "readline"
import { Logger } from "@/shared/services/Logger"
import { getBinaryLocation } from "@/utils/fs"
import { AMBIENT_RIPGREP_SCOPE, type RipgrepBudgetScope, ripgrepThreadArgs, withRipgrepSlot } from "./cpu-budget"
import { createRipgrepIgnoreFile, type RipgrepIgnoreFile, type RipgrepRuleScope } from "./ignore-file"

/*
This file provides functionality to perform regex searches on files using ripgrep.
Inspired by: https://github.com/DiscreteTom/vscode-ripgrep-utils

Key components:
* execRipgrep: Executes the ripgrep command and returns the output.
* regexSearchFiles: The main function that performs regex searches on files.
   - Parameters:
     * cwd: The current working directory (for relative path calculation)
     * directoryPath: The directory to search in
     * regex: The regular expression to search for (Rust regex syntax)
     * filePattern: Optional glob pattern to filter files (default: '*')
   - Returns: A formatted string containing search results with context

The search results include:
- Relative file paths
- 2 lines of context before and after each match
- Matches formatted with pipe characters for easy reading

Usage example:
const results = await regexSearchFiles('/path/to/cwd', '/path/to/search', 'TODO:', '*.ts');

rel/path/to/app.ts
│----
│function processData(data: any) {
│  // Some processing logic here
│  // TODO: Implement error handling
│  return processedData;
│}
│----

rel/path/to/helper.ts
│----
│  let result = 0;
│  for (let i = 0; i < input; i++) {
│    // TODO: Optimize this function for performance
│    result += Math.pow(i, 2);
│  }
│----
*/

interface SearchResult {
	filePath: string
	line: number
	column: number
	match: string
	beforeContext: string[]
	afterContext: string[]
}

const MAX_RESULTS = 300

/** Hard upper bound for one search, including CPU-slot waiting. */
export const RIPGREP_SEARCH_TIMEOUT_MS = 10 * 60 * 1000

export class RipgrepSearchTimeoutError extends Error {
	readonly code = "ripgrep_search_timeout"

	constructor(readonly timeoutMs: number = RIPGREP_SEARCH_TIMEOUT_MS) {
		super(
			`Search timed out after ${Math.ceil(timeoutMs / 60_000)} minutes. ` +
				"Narrow the search path or file_pattern; a search this broad indicates the search strategy needs to change.",
		)
		this.name = "RipgrepSearchTimeoutError"
	}
}

function signalReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Ripgrep search aborted")
}

async function execRipgrep(args: string[], scope: RipgrepBudgetScope, signal: AbortSignal): Promise<string> {
	const binPath: string = await getBinaryLocation("rg")
	if (signal.aborted) throw signalReason(signal)

	// Held until the search settles so the shared CPU budget covers the whole
	// lifetime of the process, not just its creation. Passing the signal into the
	// gate also removes a timed-out waiter before it can spawn orphaned work.
	return withRipgrepSlot(scope, () => runRipgrep(binPath, args, signal), signal)
}

function runRipgrep(binPath: string, args: string[], signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const rgProcess = childProcess.spawn(binPath, args)
		const rl = readline.createInterface({
			input: rgProcess.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		})

		let output = ""
		let errorOutput = ""
		let lineCount = 0
		let stoppingForOutputLimit = false
		let settled = false
		const maxLines = MAX_RESULTS * 5

		const cleanup = () => {
			signal.removeEventListener("abort", handleAbort)
			rl.off("line", handleLine)
			rgProcess.stderr.off("data", handleStderr)
			rgProcess.off("close", handleClose)
			rgProcess.off("error", handleError)
		}
		const settle = (error?: Error) => {
			if (settled) return
			settled = true
			cleanup()
			rl.close()
			if (error) reject(error)
			else resolve(output)
		}
		const handleLine = (line: string) => {
			if (lineCount < maxLines) {
				output += `${line}\n`
				lineCount++
				return
			}
			if (stoppingForOutputLimit) return
			stoppingForOutputLimit = true
			try {
				rgProcess.kill("SIGTERM")
			} catch (error) {
				Logger.warn(`Failed to stop ripgrep after reaching the output limit: ${error}`)
			}
		}
		const handleStderr = (data: Buffer) => {
			errorOutput += data.toString()
		}
		const handleClose = () => {
			settle(errorOutput ? new Error(`ripgrep process error: ${errorOutput}`) : undefined)
		}
		const handleError = (error: Error) => {
			settle(new Error(`ripgrep process error: ${error.message}`))
		}
		const handleAbort = () => {
			if (settled) return
			settled = true
			cleanup()
			try {
				rgProcess.kill("SIGKILL")
			} catch (error) {
				Logger.warn(`Failed to kill timed-out ripgrep process: ${error}`)
			}
			rl.close()
			rgProcess.stdout.destroy()
			rgProcess.stderr.destroy()
			reject(signalReason(signal))
		}

		rl.on("line", handleLine)
		rgProcess.stderr.on("data", handleStderr)
		rgProcess.on("close", handleClose)
		rgProcess.on("error", handleError)
		signal.addEventListener("abort", handleAbort, { once: true })
		if (signal.aborted) handleAbort()
	})
}

export async function regexSearchFiles(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern?: string,
	ignoreController?: IgnoreController,
	/** Task the CPU cost is charged to; omitted callers share the ambient scope. */
	budgetScope: RipgrepBudgetScope = AMBIENT_RIPGREP_SCOPE,
): Promise<string> {
	// Naming a pruned directory is a deliberate descent: pruning bounds the cost
	// of discovery, and a caller that already narrowed the walk to one ignored
	// path has bounded it themselves. Searching such a path would otherwise
	// return zero matches with no indication that anything was skipped, which
	// reads as "absent" rather than "not searched".
	//
	// An `.agentignore` restriction is a permission and is never lifted here.
	// Probed rather than assumed: a controller without this capability keeps the
	// previous behaviour, where the full scan rules apply and nothing is lifted.
	const describeExclusion =
		typeof ignoreController?.describeScanExclusion === "function"
			? ignoreController.describeScanExclusion.bind(ignoreController)
			: undefined
	const deliberateDescent = describeExclusion?.(directoryPath) === "pruned"
	const ruleScope: RipgrepRuleScope = deliberateDescent ? "agent-only" : "all"

	const normalizedFilePattern = filePattern?.trim()
	const hasRestrictiveFilePattern =
		normalizedFilePattern !== undefined && !["", "*", "**", "**/*"].includes(normalizedFilePattern)
	const args = [
		"--json",
		// Match the picker's budget: without an explicit cap ripgrep opens one
		// worker per logical CPU and a single tool call saturates the machine.
		...ripgrepThreadArgs(),
		"-e",
		regex,
		...(hasRestrictiveFilePattern ? ["--glob", normalizedFilePattern] : []),
		"--context",
		"1",
	]

	if (deliberateDescent) {
		// Two filters hide the named path: ripgrep's own reading of `.gitignore`
		// and the rules handed to it below. Lifting only one leaves the search
		// silently empty, so both move together.
		args.push("--no-ignore-vcs", "--hidden")
	}

	const timeoutController = new AbortController()
	const timeoutError = new RipgrepSearchTimeoutError()
	const timeout = setTimeout(() => timeoutController.abort(timeoutError), RIPGREP_SEARCH_TIMEOUT_MS)
	timeout.unref()
	let ignoreFile: RipgrepIgnoreFile | undefined
	let output: string
	try {
		ignoreFile = await createRipgrepIgnoreFile(ignoreController, ruleScope)
		args.push(...ignoreFile.args)
		args.push(directoryPath)
		output = await execRipgrep(args, budgetScope, timeoutController.signal)
	} catch (error) {
		if (error instanceof RipgrepSearchTimeoutError) throw error
		throw Error("Error calling ripgrep", { cause: error })
	} finally {
		clearTimeout(timeout)
		await ignoreFile?.dispose()
	}
	const results: SearchResult[] = []
	let currentResult: Partial<SearchResult> | null = null

	output.split("\n").forEach((line) => {
		if (line) {
			try {
				const parsed = JSON.parse(line)
				if (parsed.type === "match") {
					if (currentResult) {
						results.push(currentResult as SearchResult)
					}
					currentResult = {
						filePath: parsed.data.path.text,
						line: parsed.data.line_number,
						column: parsed.data.submatches[0].start,
						match: parsed.data.lines.text,
						beforeContext: [],
						afterContext: [],
					}
				} else if (parsed.type === "context" && currentResult) {
					if (parsed.data.line_number < currentResult.line!) {
						currentResult.beforeContext?.push(parsed.data.lines.text)
					} else {
						currentResult.afterContext?.push(parsed.data.lines.text)
					}
				}
			} catch (error) {
				Logger.error("Error parsing ripgrep output:", error)
			}
		}
	})

	if (currentResult) {
		results.push(currentResult as SearchResult)
	}

	// Safety net for patterns rg's --ignore-file may not evaluate identically.
	//
	// A deliberate descent checks the agent rules alone: the combined scan rules
	// exclude the named directory itself, so applying them here would discard
	// every match the caller just asked for.
	const filteredResults = ignoreController
		? results.filter((result) =>
				deliberateDescent && describeExclusion
					? describeExclusion(result.filePath) !== "agent-restricted"
					: ignoreController.validateAccess(result.filePath, "scan"),
			)
		: results

	return formatResults(filteredResults, cwd, deliberateDescent ? directoryPath : undefined)
}

const MAX_RIPGREP_MB = 0.25
const MAX_BYTE_SIZE = MAX_RIPGREP_MB * 1024 * 1024 // 0./25MB in bytes

/**
 * Announce that pruning was lifted for one explicitly named path.
 *
 * Without this the caller cannot tell a search that skipped a tree apart from
 * one that found nothing in it, which is exactly the confusion that makes an
 * ignored directory look empty.
 */
function describeDescent(descendedInto: string, cwd: string): string {
	const relative = path.relative(cwd, descendedInto)
	const shown = relative && !relative.startsWith("..") ? relative.toPosix() : descendedInto.toPosix()
	return (
		`Note: '${shown}' is normally pruned from searches (.gitignore or a generated-output directory). ` +
		`It was searched because you named it directly. Any '.agentignore' restriction still applies.\n\n`
	)
}

function formatResults(results: SearchResult[], cwd: string, descendedInto?: string): string {
	const groupedResults: { [key: string]: SearchResult[] } = {}

	let output = ""
	if (descendedInto) {
		output += describeDescent(descendedInto, cwd)
	}
	if (results.length >= MAX_RESULTS) {
		output += `Showing first ${MAX_RESULTS} of ${MAX_RESULTS}+ results. Use a more specific search if necessary.\n\n`
	} else {
		output += `Found ${results.length === 1 ? "1 result" : `${results.length.toLocaleString()} results`}.\n\n`
	}

	// Group results by file name
	results.slice(0, MAX_RESULTS).forEach((result) => {
		const relativeFilePath = path.relative(cwd, result.filePath)
		if (!groupedResults[relativeFilePath]) {
			groupedResults[relativeFilePath] = []
		}
		groupedResults[relativeFilePath].push(result)
	})

	// Track byte size
	let byteSize = Buffer.byteLength(output, "utf8")
	let wasLimitReached = false

	for (const [filePath, fileResults] of Object.entries(groupedResults)) {
		// Check if adding this file's path would exceed the byte limit
		const filePathString = `${filePath.toPosix()}\n│----\n`
		const filePathBytes = Buffer.byteLength(filePathString, "utf8")

		if (byteSize + filePathBytes >= MAX_BYTE_SIZE) {
			wasLimitReached = true
			break
		}

		output += filePathString
		byteSize += filePathBytes

		for (let resultIndex = 0; resultIndex < fileResults.length; resultIndex++) {
			const result = fileResults[resultIndex]
			const allLines = [...result.beforeContext, result.match, ...result.afterContext]
			// Compute base line number for the first context line.
			// Match line is result.line (1-based); beforeContext lines precede it.
			const firstContextLine = result.line - result.beforeContext.length

			// Calculate bytes in all lines for this result
			let resultBytes = 0
			const resultLines: string[] = []

			for (let i = 0; i < allLines.length; i++) {
				const line = allLines[i]
				const lineNumber = firstContextLine + i
				const trimmedLine = line?.trimEnd() ?? ""
				const lineString = `${lineNumber} | ${trimmedLine}\n`
				const lineBytes = Buffer.byteLength(lineString, "utf8")

				// Check if adding this line would exceed the byte limit
				if (byteSize + resultBytes + lineBytes >= MAX_BYTE_SIZE) {
					wasLimitReached = true
					break
				}

				resultLines.push(lineString)
				resultBytes += lineBytes
			}

			// If we hit the limit in the middle of processing lines, break out of the result loop
			if (wasLimitReached) {
				break
			}

			// Add all lines for this result to the output
			resultLines.forEach((line) => {
				output += line
			})
			byteSize += resultBytes

			// Add separator between results if needed
			if (resultIndex < fileResults.length - 1) {
				const separatorString = "│----\n"
				const separatorBytes = Buffer.byteLength(separatorString, "utf8")

				if (byteSize + separatorBytes >= MAX_BYTE_SIZE) {
					wasLimitReached = true
					break
				}

				output += separatorString
				byteSize += separatorBytes
			}

			// Check if we've hit the byte limit
			if (byteSize >= MAX_BYTE_SIZE) {
				wasLimitReached = true
				break
			}
		}

		// If we hit the limit, break out of the file loop
		if (wasLimitReached) {
			break
		}

		const closingString = "│----\n\n"
		const closingBytes = Buffer.byteLength(closingString, "utf8")

		if (byteSize + closingBytes >= MAX_BYTE_SIZE) {
			wasLimitReached = true
			break
		}

		output += closingString
		byteSize += closingBytes
	}

	// Add a message if we hit the byte limit
	if (wasLimitReached) {
		const truncationMessage = `\n[Results truncated due to exceeding the ${MAX_RIPGREP_MB}MB size limit. Please use a more specific search pattern.]`
		// Only add the message if it fits within the limit
		if (byteSize + Buffer.byteLength(truncationMessage, "utf8") < MAX_BYTE_SIZE) {
			output += truncationMessage
		}
	}

	return output.trim()
}
