/**
 * Diagnostic value normalization for the extension's human-readable log channel.
 *
 * The Logger accepts arbitrary values from every call site, so it cannot trust
 * that a caller already stripped user content. This module is the single place
 * that decides what an arbitrary value is allowed to contribute to Dline
 * Output: identity, status, and shape are kept, while the bodies a user typed
 * or a tool produced are replaced by a summary.
 *
 * This is deliberately separate from the runtime telemetry content policy.
 * Telemetry events carry typed payloads whose fields are known ahead of time;
 * this module only has to survive untyped input.
 */

/** Keys whose value is a credential regardless of the surrounding shape. */
const SECRET_KEYS = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"clientsecret",
	"cookie",
	"credential",
	"idtoken",
	"password",
	"privatekey",
	"proxyauthorization",
	"refreshtoken",
	"secret",
	"session",
	"setcookie",
	"token",
	"xapikey",
])

/**
 * Keys whose value is user or tool content: a command line, a prompt, a task
 * title, a file body, a tool result. These never belong in the log channel,
 * but their size and presence are useful, so they are summarized instead of
 * dropped outright.
 */
const CONTENT_KEYS = new Set([
	"args",
	"argument",
	"arguments",
	"body",
	"cmd",
	"code",
	"command",
	"commandline",
	"completion",
	"content",
	"contents",
	"diff",
	"filecontent",
	"input",
	"instructions",
	"message",
	"messages",
	"output",
	"params",
	"patch",
	"payload",
	"prompt",
	"query",
	"reply",
	"response",
	"result",
	"script",
	"snippet",
	"stderr",
	"stdin",
	"stdout",
	"systemprompt",
	"text",
	"title",
	"value",
	"values",
])

/**
 * Error-shaped keys that stay verbatim. They identify a failure without
 * revealing what the user was doing, and losing them would make production
 * logs undiagnosable.
 */
const ERROR_IDENTITY_KEYS = new Set(["code", "errno", "status", "statuscode", "syscall", "requestid", "name"])

/**
 * `message` is a content key on tool and protocol payloads, but on an
 * error-shaped object it is the only human-readable description of the
 * failure. Inside an error shape it is truncated and redacted rather than
 * summarized.
 */
const ERROR_MESSAGE_KEY = "message"

const AUTHORIZATION_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[^\s"'}]+/gi
const LABELED_CREDENTIAL_PATTERN =
	/\b(api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|password|private[-_ ]?key|proxy[-_ ]?authorization|credential|secret|session|cookie|set[-_ ]?cookie|token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi
const TOKEN_VALUE_PATTERN =
	/\b(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|pk_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,})\b/g
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const MAX_STRING_LENGTH = 512
const MAX_DEPTH = 6

function normalizeKey(key: string): string {
	return key.toLowerCase().replaceAll("-", "").replaceAll("_", "")
}

function isSecretKey(key: string): boolean {
	return SECRET_KEYS.has(normalizeKey(key))
}

/**
 * Content keys are matched only when the key is not also an error identity
 * key. `code` means "error code" on an Error and "source code" on a tool
 * payload; the Error meaning wins because it appears in the same objects that
 * carry `name` and `message`.
 */
function isContentKey(key: string, inErrorShape: boolean): boolean {
	const normalized = normalizeKey(key)
	if (inErrorShape && (ERROR_IDENTITY_KEYS.has(normalized) || normalized === ERROR_MESSAGE_KEY)) return false
	return CONTENT_KEYS.has(normalized)
}

/**
 * Strip credentials that were interpolated into a message string.
 *
 * The pattern is module-level and carries the `g` flag, so `lastIndex` must be
 * reset before each use. Otherwise a second call resumes where the first one
 * stopped and leaves a later credential in the output.
 */
export function redactDiagnosticString(value: string): string {
	AUTHORIZATION_VALUE_PATTERN.lastIndex = 0
	LABELED_CREDENTIAL_PATTERN.lastIndex = 0
	TOKEN_VALUE_PATTERN.lastIndex = 0
	PRIVATE_KEY_PATTERN.lastIndex = 0

	return value
		.replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
		.replace(AUTHORIZATION_VALUE_PATTERN, (match) => `${match.slice(0, match.indexOf(" ") + 1)}[REDACTED]`)
		.replace(LABELED_CREDENTIAL_PATTERN, (_match, key: string, separator: string, credential: string) => {
			const quote = credential.startsWith('"') ? '"' : credential.startsWith("'") ? "'" : ""
			return `${key}${separator}${quote}[REDACTED]${quote}`
		})
		.replace(TOKEN_VALUE_PATTERN, "[REDACTED]")
}

/**
 * Describe a value's size without reproducing it.
 *
 * Objects keep their error identity fields alongside the summary. A wrapper
 * such as an HTTP `response` is a content key, but dropping its `status` would
 * remove the one field that makes a production failure diagnosable.
 */
function summarizeContent(value: unknown): unknown {
	if (typeof value === "string") {
		const lines = value.split("\n").length
		return lines > 1 ? `[content chars=${value.length} lines=${lines}]` : `[content chars=${value.length}]`
	}
	if (Array.isArray(value)) return `[content items=${value.length}]`
	if (value === null || value === undefined) return "[content empty]"
	if (typeof value !== "object") return `[content ${typeof value}]`

	const entries = Object.entries(value as Record<string, unknown>)
	const identity: Record<string, unknown> = {}
	for (const [key, entry] of entries) {
		if (!ERROR_IDENTITY_KEYS.has(normalizeKey(key))) continue
		if (typeof entry === "string" || typeof entry === "number") identity[key] = entry
	}

	const summary = `[content keys=${entries.length}]`
	return Object.keys(identity).length > 0 ? { ...identity, summary } : summary
}

function truncateString(value: string): string {
	const redacted = redactDiagnosticString(value)
	if (redacted.length <= MAX_STRING_LENGTH) return redacted
	return `${redacted.slice(0, MAX_STRING_LENGTH)}… [truncated chars=${redacted.length}]`
}

function isErrorShape(value: object): boolean {
	if (value instanceof Error) return true
	const record = value as Record<string, unknown>
	return typeof record.name === "string" && typeof record.message === "string"
}

/**
 * Convert an arbitrary logged value into something safe to publish.
 *
 * Objects keep their structure so a reader can still tell what failed; only
 * secret and content values are replaced. Errors additionally keep their
 * `name`, `message`, `stack`, and `cause` so a stack trace remains usable.
 */
export function toSafeDiagnosticValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return truncateString(value)
	if (value === null || typeof value !== "object") return value
	if (seen.has(value)) return "[Circular]"
	if (depth >= MAX_DEPTH) return "[depth limit]"
	seen.add(value)

	if (Array.isArray(value)) {
		return value.map((item) => toSafeDiagnosticValue(item, depth + 1, seen))
	}

	const errorShape = isErrorShape(value)
	const result: Record<string, unknown> = {}

	if (value instanceof Error) {
		result.name = truncateString(value.name)
		result.message = truncateString(value.message)
		if (value.stack) result.stack = truncateString(value.stack)
		if (value.cause !== undefined) result.cause = toSafeDiagnosticValue(value.cause, depth + 1, seen)
	}

	for (const [key, entry] of Object.entries(value)) {
		if (isSecretKey(key)) {
			result[key] = "[REDACTED]"
			continue
		}
		if (isContentKey(key, errorShape)) {
			result[key] = summarizeContent(entry)
			continue
		}
		result[key] = toSafeDiagnosticValue(entry, depth + 1, seen)
	}

	return result
}

/** Serialize a logged argument for the output channel. */
export function formatDiagnosticArgument(value: unknown): string {
	try {
		return JSON.stringify(toSafeDiagnosticValue(value)) ?? String(value)
	} catch {
		return redactDiagnosticString(String(value))
	}
}
