import { createHmac, randomBytes } from "node:crypto"
import { redactDiagnosticString } from "@/shared/services/logging/safe-diagnostic-value"
import { isTelemetryDevelopmentMode } from "../development-mode"
import { TELEMETRY_MASK_VALUE } from "../service/pipeline-port"
import { readErrorIdentifier } from "./exception-attributes"
import type { RuntimeAttributes, RuntimeAttributeValue } from "./types"

export { TELEMETRY_MASK_VALUE } from "../service/pipeline-port"

/**
 * Content policy for runtime telemetry attributes.
 *
 * Producers pass untyped attribute bags, so this module is the boundary that
 * decides what may leave the extension host. It rejects the fields that carry
 * user or tool content outright rather than truncating them, because a
 * truncated command line is still a command line.
 */

const CONTENT_KEYS = new Set([
	"args",
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
	"errormessage",
	"exceptionmessage",
	"loggermessage",
	"message",
	"messages",
	"modeloutput",
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
])

const CREDENTIAL_KEYS = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"clientsecret",
	"cookie",
	"credential",
	"idtoken",
	"oauth",
	"oauthcredential",
	"oauthtoken",
	"password",
	"privatekey",
	"proxyauthorization",
	"refreshtoken",
	"secret",
	"setcookie",
	"token",
	"xapikey",
])

const IDENTITY_KEYS = new Set([
	"alias",
	"controllerid",
	"distinctid",
	"displayname",
	"email",
	"firstname",
	"lastname",
	"memberid",
	"organizationid",
	"organizationname",
	"taskid",
	"ulid",
	"userid",
	"username",
	"workspaceid",
])

const HIGH_CARDINALITY_EXEMPT_SEGMENTS = new Set([
	"apiformat",
	"capabilities",
	"capability",
	"cache",
	"cost",
	"count",
	"duration",
	"extensionversion",
	"model",
	"modelid",
	"modellist",
	"models",
	"outcome",
	"phase",
	"platformversion",
	"provider",
	"snapshot",
	"stage",
	"state",
	"status",
	"tokens",
	"vscodeversion",
])

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"])
const DEVELOPMENT_DIAGNOSTIC_KEYS = new Set(["diagnostic_message", "diagnostic_exception_message", "diagnostic_logger_message"])
const CREDENTIAL_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[^\s"'}]+|\b(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/i

/** Long safe identifiers such as model IDs and capability names remain queryable. */
const MAX_ATTRIBUTE_LENGTH = 512
/** Enough room for bounded model/capability lists and snapshot state without order-dependent loss. */
const MAX_ATTRIBUTE_COUNT = 128
const MAX_ARRAY_ITEMS = 32
const MAX_DEPTH = 10
const MAX_CARDINALITY = 200

export enum AttributeRejection {
	ForbiddenKey = "forbidden_key",
	MaskedContent = "masked_content",
	MaskedCredential = "masked_credential",
	MaskedIdentity = "masked_identity",
	UnsupportedType = "unsupported_type",
	TooLong = "too_long",
	TooManyAttributes = "too_many_attributes",
	HighCardinality = "high_cardinality",
}

export interface AttributePolicyResult {
	readonly attributes: RuntimeAttributes
	readonly rejections: ReadonlyMap<string, AttributeRejection>
}

interface RuntimeContentPolicyOptions {
	readonly preserveTaskIdentity?: boolean
	readonly preserveDevelopmentDiagnostics?: boolean
}

function normalizeKeyPart(key: string): string {
	return key.toLowerCase().replaceAll("-", "").replaceAll("_", "")
}

function keySegments(key: string): readonly string[] {
	return key.split(".").filter(Boolean).map(normalizeKeyPart)
}

function sensitiveRejection(key: string): AttributeRejection | undefined {
	const segments = keySegments(key)
	const numericUsageDimension = segments.some((segment) => ["cache", "cost", "token", "tokens", "tokenusage"].includes(segment))
	for (const segment of segments) {
		if (CREDENTIAL_KEYS.has(segment)) return AttributeRejection.MaskedCredential
		if (IDENTITY_KEYS.has(segment)) return AttributeRejection.MaskedIdentity
		if (CONTENT_KEYS.has(segment)) {
			if (numericUsageDimension && (segment === "input" || segment === "output")) continue
			return AttributeRejection.MaskedContent
		}
	}
	return undefined
}

function isHighCardinalityExempt(key: string): boolean {
	return keySegments(key).some(
		(segment) =>
			HIGH_CARDINALITY_EXEMPT_SEGMENTS.has(segment) ||
			segment.includes("model") ||
			segment.includes("version") ||
			segment.includes("token") ||
			segment.includes("snapshot") ||
			segment.includes("capabilit"),
	)
}

interface FlattenedAttribute {
	readonly key: string
	readonly value: unknown
	readonly forcedRejection?: AttributeRejection
}

/**
 * Enforces the attribute contract and tracks per-name cardinality.
 *
 * Cardinality is stateful across events, so this is a class rather than a
 * free function: a single-event view cannot tell a stable dimension from an
 * identifier.
 */
export class RuntimeContentPolicy {
	/** Session-scoped key so fingerprints cannot be correlated across installs. */
	private readonly fingerprintKey: Buffer
	private readonly observedValues = new Map<string, Set<string>>()

	constructor(
		fingerprintKey: Buffer = randomBytes(32),
		private readonly options: RuntimeContentPolicyOptions = {},
	) {
		this.fingerprintKey = fingerprintKey
	}

	/** Development correlation is limited to events/traces, never metric dimensions. */
	static forEvents(fingerprintKey?: Buffer): RuntimeContentPolicy {
		const developmentMode = isTelemetryDevelopmentMode()
		return new RuntimeContentPolicy(fingerprintKey, {
			preserveTaskIdentity: developmentMode,
			preserveDevelopmentDiagnostics: developmentMode,
		})
	}

	/**
	 * Derive a stable, non-reversible identifier for a sensitive value.
	 *
	 * Used for workspace roots, command shapes, and error grouping, where
	 * events must be correlatable without revealing the original value.
	 */
	fingerprint(value: string): string {
		return createHmac("sha256", this.fingerprintKey).update(value).digest("hex").slice(0, 16)
	}

	/** Apply the attribute contract, preserving field shape while masking sensitive values. */
	apply(input: Readonly<Record<string, unknown>> | undefined): AttributePolicyResult {
		const attributes: Record<string, RuntimeAttributeValue> = {}
		const rejections = new Map<string, AttributeRejection>()
		if (!input) return { attributes, rejections }

		const flattened: FlattenedAttribute[] = []
		const seen = new WeakSet<object>()
		for (const [key, value] of Object.entries(input)) this.flatten(key, value, flattened, seen, 0)

		let retained = 0
		for (const { key, value, forcedRejection } of flattened) {
			if (retained >= MAX_ATTRIBUTE_COUNT) {
				rejections.set(key, AttributeRejection.TooManyAttributes)
				continue
			}
			if (forcedRejection) {
				attributes[key] = TELEMETRY_MASK_VALUE
				rejections.set(key, forcedRejection)
				retained += 1
				continue
			}

			const rejection = this.admit(key, value, attributes)
			if (rejection) {
				attributes[key] = TELEMETRY_MASK_VALUE
				rejections.set(key, rejection)
			}
			retained += 1
		}

		return { attributes, rejections }
	}

	/** Reset cardinality tracking. Used when a session ends. */
	reset(): void {
		this.observedValues.clear()
	}

	private flatten(key: string, value: unknown, output: FlattenedAttribute[], seen: WeakSet<object>, depth: number): void {
		if (this.options.preserveTaskIdentity && isTaskIdentityKey(key)) {
			output.push({
				key,
				value,
				forcedRejection:
					typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
						? undefined
						: AttributeRejection.MaskedIdentity,
			})
			return
		}
		// These exact protocol fields are not response content or source code.
		if (key === "dline.exception.code") {
			const code = readErrorIdentifier(value)
			output.push({ key, value: code ?? TELEMETRY_MASK_VALUE })
			return
		}
		if (key === "http.response.status_code") {
			output.push({
				key,
				value:
					typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
						? value
						: TELEMETRY_MASK_VALUE,
			})
			return
		}
		const masked = sensitiveRejection(key)
		if (masked) {
			output.push({ key, value: TELEMETRY_MASK_VALUE, forcedRejection: masked })
			return
		}
		if (value === null || value === undefined) {
			output.push({ key, value: String(value) })
			return
		}
		if (typeof value !== "object") {
			output.push({ key, value })
			return
		}
		if (seen.has(value) || depth >= MAX_DEPTH) {
			output.push({ key, value: TELEMETRY_MASK_VALUE, forcedRejection: AttributeRejection.UnsupportedType })
			return
		}
		seen.add(value)

		if (value instanceof Date) {
			output.push({ key, value: value.toISOString() })
			return
		}
		if (value instanceof Error) {
			output.push({ key: `${key}.name`, value: value.name })
			output.push({ key: `${key}.message`, value: TELEMETRY_MASK_VALUE, forcedRejection: AttributeRejection.MaskedContent })
			const record = value as Error & { code?: unknown; status?: unknown }
			if (record.code !== undefined) this.flatten(`${key}.code`, record.code, output, seen, depth + 1)
			if (record.status !== undefined) this.flatten(`${key}.status`, record.status, output, seen, depth + 1)
			return
		}
		if (Array.isArray(value)) {
			for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index++) {
				this.flatten(`${key}.${index}`, value[index], output, seen, depth + 1)
			}
			if (value.length > MAX_ARRAY_ITEMS) output.push({ key: `${key}.truncated`, value: true })
			return
		}

		for (const [nestedKey, nestedValue] of Object.entries(value)) {
			if (PROTOTYPE_KEYS.has(nestedKey)) continue
			this.flatten(`${key}.${nestedKey}`, nestedValue, output, seen, depth + 1)
		}
	}

	private admit(
		key: string,
		value: unknown,
		attributes: Record<string, RuntimeAttributeValue>,
	): AttributeRejection | undefined {
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return AttributeRejection.UnsupportedType
			attributes[key] = value
			return undefined
		}
		if (typeof value === "boolean") {
			attributes[key] = value
			return undefined
		}
		if (typeof value !== "string") {
			return AttributeRejection.UnsupportedType
		}
		if (this.options.preserveDevelopmentDiagnostics && isDevelopmentDiagnosticKey(key)) {
			attributes[key] = truncateDevelopmentDiagnostic(redactDiagnosticString(value))
			return undefined
		}
		if (value.length > MAX_ATTRIBUTE_LENGTH) return AttributeRejection.TooLong
		if (CREDENTIAL_VALUE_PATTERN.test(value)) return AttributeRejection.MaskedCredential
		const correlation = this.options.preserveTaskIdentity && isTaskIdentityKey(key)
		if (!correlation && !isHighCardinalityExempt(key) && this.exceedsCardinality(key, value)) {
			return AttributeRejection.HighCardinality
		}

		attributes[key] = value
		return undefined
	}

	private exceedsCardinality(key: string, value: string): boolean {
		let seen = this.observedValues.get(key)
		if (!seen) {
			seen = new Set<string>()
			this.observedValues.set(key, seen)
		}
		if (seen.has(value)) return false
		if (seen.size >= MAX_CARDINALITY) return true
		seen.add(value)
		return false
	}
}

function isDevelopmentDiagnosticKey(key: string): boolean {
	return DEVELOPMENT_DIAGNOSTIC_KEYS.has(key) || /^diagnostic_logger_args\.\d+$/.test(key)
}

function truncateDevelopmentDiagnostic(value: string): string {
	if (value.length <= MAX_ATTRIBUTE_LENGTH) return value
	const suffix = `… [truncated chars=${value.length}]`
	return `${value.slice(0, MAX_ATTRIBUTE_LENGTH - suffix.length)}${suffix}`
}

/** Exact correlation keys only; nested content/credential fields cannot opt out of masking. */
function isTaskIdentityKey(key: string): boolean {
	return /^(?:taskId|task_id|dline\.task_id|active_task_ids\.\d+)$/.test(key)
}

export const runtimeContentPolicyLimits = {
	MAX_ATTRIBUTE_LENGTH,
	MAX_ATTRIBUTE_COUNT,
	MAX_ARRAY_ITEMS,
	MAX_DEPTH,
	MAX_CARDINALITY,
} as const
