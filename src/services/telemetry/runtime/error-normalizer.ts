import { createHash } from "node:crypto"
import { TELEMETRY_MASK_VALUE } from "../service/pipeline-port"
import { readErrorIdentifier } from "./exception-attributes"
import type { NormalizedRuntimeError } from "./types"

/**
 * Reduce an arbitrary thrown value to fields that are safe to publish and
 * stable enough to group by.
 *
 * Producers catch values from HTTP clients, SDKs, and the platform, so this
 * accepts `unknown`. Fingerprint v2 uses only bounded type/code/status and
 * source file, never error prose or user content. Exact source lines remain
 * available separately without fragmenting grouping when code moves.
 */

const MAX_CAUSE_DEPTH = 3

interface ErrorLikeFields {
	readonly name?: unknown
	readonly message?: unknown
	readonly code?: unknown
	readonly status?: unknown
	readonly statusCode?: unknown
	readonly stack?: unknown
	readonly cause?: unknown
	readonly _error?: unknown
	readonly response?: unknown
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function readStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function errorFields(value: unknown): ErrorLikeFields {
	return value !== null && typeof value === "object" ? value : {}
}

/**
 * Extract the first project stack frame, reduced to `file:line`.
 *
 * The absolute prefix identifies the developer's machine and the install
 * location, so only the path tail is kept.
 */
function extractSourceFrame(stack: string | undefined): string | undefined {
	if (!stack) return undefined
	for (const line of stack.split("\n")) {
		const match = /\(?([^()\s]+[/\\][^()\s]+?):(\d+):\d+\)?$/.exec(line.trim())
		if (!match) continue
		const [, filePath, lineNumber] = match
		if (filePath.includes("node_modules")) continue
		const segments = filePath.split(/[/\\]/)
		const tail = segments.slice(-2).join("/")
		return `${tail}:${lineNumber}`
	}
	return undefined
}

function buildFingerprint(name: string, code?: string, status?: number, sourceFrame?: string): string {
	const sourceFile = sourceFrame?.replace(/:\d+$/, "")
	const groupingMaterial = ["v2", name, code ?? "-", status ?? "-", sourceFile ?? "-"].join("|")
	return createHash("sha256").update(groupingMaterial).digest("hex").slice(0, 16)
}

export function normalizeRuntimeError(value: unknown, depth = 0): NormalizedRuntimeError {
	if (typeof value === "string") {
		return {
			name: "Error",
			message: TELEMETRY_MASK_VALUE,
			fingerprint: buildFingerprint("Error"),
		}
	}
	if (value === null || typeof value !== "object") {
		return {
			name: "NonError",
			message: TELEMETRY_MASK_VALUE,
			fingerprint: buildFingerprint("NonError"),
		}
	}

	const fields = errorFields(value)
	const wrapped = errorFields(fields._error)
	const response = errorFields(fields.response)
	const name = readErrorIdentifier(fields.name) ?? "Error"
	const code = readErrorIdentifier(fields.code) ?? readErrorIdentifier(wrapped.code)
	const status =
		readStatus(fields.status) ?? readStatus(fields.statusCode) ?? readStatus(wrapped.status) ?? readStatus(response.status)
	const sourceFrame = extractSourceFrame(readString(fields.stack))

	const cause =
		fields.cause !== undefined && depth < MAX_CAUSE_DEPTH ? normalizeRuntimeError(fields.cause, depth + 1) : undefined

	return {
		name,
		message: TELEMETRY_MASK_VALUE,
		code,
		status,
		sourceFrame,
		fingerprint: buildFingerprint(name, code, status, sourceFrame),
		cause,
	}
}
