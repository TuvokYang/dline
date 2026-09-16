import { createHash } from "node:crypto"
import type { E2EMockApiProtocol, E2EMockProviderTarget } from "./api"

const TOKEN_ESTIMATE_BYTES = 4
const PREFIX_REGRESSION_RATIO = 0.8
const PREFIX_REGRESSION_MIN_TOKENS = 32
const PLATEAU_OBSERVATION_COUNT = 3
const PLATEAU_GROWTH_MIN_TOKENS = 64
const CACHE_READ_GROWTH_TOLERANCE = 4

const OPENAI_TARGETS = new Set<E2EMockProviderTarget>([
	"openai-compatible-chat",
	"openai-compatible-responses",
	"openai-official-responses",
])

export interface OpenAiCacheUsage {
	readonly inputTokens: number
	readonly cacheReadTokens?: number
	readonly cacheWriteTokens?: number
}

export interface DerivedOpenAiCacheUsage extends OpenAiCacheUsage {
	readonly totalInputTokens: number
	readonly reusablePrefixTokens: number
}

export type MockCacheWarningCode =
	| "identity_changed"
	| "prefix_hash_mismatch"
	| "prefix_regression"
	| "cache_plateau"
	| "warm_cache_miss"

export interface MockCacheWarning {
	readonly code: MockCacheWarningCode
	readonly message: string
	readonly target: E2EMockProviderTarget
	readonly requestIndex: number
	readonly previousCacheReadTokens?: number
	readonly cacheReadTokens: number
	readonly totalInputTokens: number
}

export interface MockCacheFirstDivergence {
	readonly component: "instructions" | "messages" | "input" | "tools"
	readonly path: string
	readonly byteOffset: number
	readonly estimatedTokenOffset: number
	readonly beforeHash: string
	readonly afterHash: string
	readonly beforeText: string
	readonly afterText: string
}

export interface MockCacheProjectionMetadata {
	readonly protocol: E2EMockApiProtocol
	readonly mode: "automatic" | "explicit"
	readonly systemPlacement: "instructions" | "messages" | "input" | "none"
	readonly promptCacheKeyPresent: boolean
	readonly promptCacheOptionsPresent: boolean
	readonly breakpointPresent: boolean
}

export interface MockCacheDiagnostic {
	readonly state: "cold" | "warm" | "miss" | "prefix_mismatch" | "regressed" | "plateau"
	readonly identity: string
	readonly requestIndex: number
	readonly previousRequestIndex?: number
	readonly totalInputTokens: number
	readonly previousTotalInputTokens?: number
	readonly inputGrowthTokens: number
	readonly reusablePrefixTokens: number
	readonly cacheReadTokens: number
	readonly previousCacheReadTokens?: number
	readonly cacheReadGrowthTokens: number
	readonly cacheWriteTokens: number
	readonly componentHashes: Readonly<Record<"system" | "content" | "tools", string>>
	readonly componentTokenEstimates: Readonly<Record<"system" | "content" | "tools", number>>
	readonly componentTexts: Readonly<Record<"system" | "content" | "tools", string>>
	readonly expectedPrefixHash?: string
	readonly actualPrefixHash: string
	readonly prefixHashMatched?: boolean
	readonly expectedPrefixBytes?: number
	readonly actualPrefixBytes: number
	readonly stablePrefixTokens: number
	readonly promptHash: string
	readonly previousPromptHash?: string
	readonly matchedPrefixHash?: string
	readonly matchedPrefixBytes: number
	readonly firstDivergence?: MockCacheFirstDivergence
	readonly projection: MockCacheProjectionMetadata
	readonly warnings: readonly MockCacheWarning[]
}

interface SemanticPromptSegment {
	readonly component: MockCacheFirstDivergence["component"]
	readonly group: "system" | "content" | "tools"
	readonly path: string
	readonly text: string
}

interface CacheRequestProjection {
	readonly identity: string
	readonly promptText: string
	readonly stablePrefixText: string
	readonly segments: readonly SemanticPromptSegment[]
	readonly componentHashes: MockCacheDiagnostic["componentHashes"]
	readonly componentTokenEstimates: MockCacheDiagnostic["componentTokenEstimates"]
	readonly componentTexts: MockCacheDiagnostic["componentTexts"]
	readonly stablePrefixHash: string
	readonly promptHash: string
	readonly projection: MockCacheProjectionMetadata
}

interface CacheObservation {
	readonly requestIndex: number
	readonly identity: string
	readonly promptText: string
	readonly stablePrefixText: string
	readonly stablePrefixHash: string
	readonly promptHash: string
	readonly segments: readonly SemanticPromptSegment[]
	readonly totalInputTokens: number
	readonly reusablePrefixTokens: number
	readonly cacheReadTokens: number
}

interface TargetCacheState {
	readonly observations: CacheObservation[]
	readonly highWaterPrefixByIdentity: Map<string, number>
	lastIdentity?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function estimateTokens(text: string): number {
	return text.length === 0 ? 0 : Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / TOKEN_ESTIMATE_BYTES))
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length)
	let index = 0
	while (index < limit && left[index] === right[index]) index++
	return index
}

function stableSerialize(value: unknown): string {
	if (value === undefined) return "undefined"
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
		.join(",")}}`
}

function wireSerialize(value: unknown): string {
	const serialized = JSON.stringify(value)
	return serialized === undefined ? "undefined" : serialized
}

function hashProjection(value: unknown): string {
	return createHash("sha256").update(stableSerialize(value)).digest("hex").slice(0, 16)
}

function hashText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex")
}

function containsPromptCacheBreakpoint(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsPromptCacheBreakpoint)
	const record = asRecord(value)
	if (!record) return false
	return "prompt_cache_breakpoint" in record || Object.values(record).some(containsPromptCacheBreakpoint)
}

function appendSemanticLeaves(
	segments: SemanticPromptSegment[],
	component: SemanticPromptSegment["component"],
	group: SemanticPromptSegment["group"],
	path: string,
	value: unknown,
): void {
	if (Array.isArray(value)) {
		if (value.length === 0) segments.push({ component, group, path, text: "[]" })
		for (const [index, entry] of value.entries()) appendSemanticLeaves(segments, component, group, `${path}[${index}]`, entry)
		return
	}
	const record = asRecord(value)
	if (record) {
		const entries = Object.entries(record)
		if (entries.length === 0) segments.push({ component, group, path, text: "{}" })
		for (const [key, entry] of entries) appendSemanticLeaves(segments, component, group, path ? `${path}.${key}` : key, entry)
		return
	}
	segments.push({ component, group, path, text: wireSerialize(value) })
}

function serializeSegments(segments: readonly SemanticPromptSegment[]): string {
	return segments.map(({ component, path, text }) => `${component}\u0000${path}\u0000${text}\u0000`).join("")
}

function componentSegments(
	segments: readonly SemanticPromptSegment[],
	group: SemanticPromptSegment["group"],
): readonly SemanticPromptSegment[] {
	return segments.filter((segment) => segment.group === group)
}

function hashComponent(segments: readonly SemanticPromptSegment[], group: SemanticPromptSegment["group"]): string {
	return hashProjection(componentSegments(segments, group).map(({ path, text }) => ({ path, text })))
}

function createProjection(protocol: E2EMockApiProtocol, requestBody: unknown): CacheRequestProjection | undefined {
	if (protocol !== "openai-chat" && protocol !== "openai-responses") return undefined
	const body = asRecord(requestBody)
	if (!body) return undefined

	const promptCacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined
	const promptCacheOptionsPresent = body.prompt_cache_options !== undefined
	const breakpointPresent = containsPromptCacheBreakpoint(body)
	const mode = promptCacheOptionsPresent || breakpointPresent ? "explicit" : "automatic"
	const systemSegments: SemanticPromptSegment[] = []
	const contentSegments: SemanticPromptSegment[] = []
	const toolSegments: SemanticPromptSegment[] = []
	let systemPlacement: MockCacheProjectionMetadata["systemPlacement"] = "none"

	if (protocol === "openai-chat") {
		const messages = Array.isArray(body.messages) ? body.messages : []
		let contentStart = 0
		for (const [index, message] of messages.entries()) {
			const role = asRecord(message)?.role
			if (index !== contentStart || (role !== "system" && role !== "developer")) break
			appendSemanticLeaves(systemSegments, "messages", "system", `messages[${index}]`, message)
			contentStart++
			systemPlacement = "messages"
		}
		for (let index = contentStart; index < messages.length; index++) {
			appendSemanticLeaves(contentSegments, "messages", "content", `messages[${index}]`, messages[index])
		}
	} else if (body.instructions !== undefined) {
		appendSemanticLeaves(systemSegments, "instructions", "system", "instructions", body.instructions)
		systemPlacement = "instructions"
		if (Array.isArray(body.input)) {
			for (const [index, item] of body.input.entries()) {
				appendSemanticLeaves(contentSegments, "input", "content", `input[${index}]`, item)
			}
		} else if (body.input !== undefined) {
			appendSemanticLeaves(contentSegments, "input", "content", "input", body.input)
		}
	} else if (Array.isArray(body.input)) {
		let contentStart = 0
		for (const [index, item] of body.input.entries()) {
			const role = asRecord(item)?.role
			if (index !== contentStart || role !== "system") break
			appendSemanticLeaves(systemSegments, "input", "system", `input[${index}]`, item)
			contentStart++
			systemPlacement = "input"
		}
		for (let index = contentStart; index < body.input.length; index++) {
			appendSemanticLeaves(contentSegments, "input", "content", `input[${index}]`, body.input[index])
		}
	} else if (body.input !== undefined) {
		appendSemanticLeaves(contentSegments, "input", "content", "input", body.input)
	}
	appendSemanticLeaves(toolSegments, "tools", "tools", "tools", body.tools ?? [])

	// Request-level tools are part of the stable reusable prefix even though
	// they are serialized separately from messages/input on the wire.
	const segments = [...systemSegments, ...toolSegments, ...contentSegments]
	const stablePrefixSegments = [...systemSegments, ...toolSegments]
	const stablePrefixText = serializeSegments(stablePrefixSegments)
	const promptText = serializeSegments(segments)
	const componentTexts = {
		system: serializeSegments(systemSegments),
		content: serializeSegments(contentSegments),
		tools: serializeSegments(toolSegments),
	}

	const identityProjection = {
		protocol,
		model: body.model,
		promptCacheKey,
		include: body.include,
	}
	const projection: MockCacheProjectionMetadata = {
		protocol,
		mode,
		systemPlacement,
		promptCacheKeyPresent: promptCacheKey !== undefined,
		promptCacheOptionsPresent,
		breakpointPresent,
	}

	return {
		identity: `${promptCacheKey ?? "auto"}:${hashProjection(identityProjection)}`,
		promptText,
		stablePrefixText,
		segments,
		componentHashes: {
			system: hashComponent(segments, "system"),
			content: hashComponent(segments, "content"),
			tools: hashComponent(segments, "tools"),
		},
		componentTokenEstimates: {
			system: estimateTokens(componentTexts.system),
			content: estimateTokens(componentTexts.content),
			tools: estimateTokens(componentTexts.tools),
		},
		componentTexts,
		stablePrefixHash: hashText(stablePrefixText),
		promptHash: hashText(promptText),
		projection,
	}
}

function firstStringByteDifference(left: string, right: string): number {
	const leftBytes = Buffer.from(left, "utf8")
	const rightBytes = Buffer.from(right, "utf8")
	const limit = Math.min(leftBytes.length, rightBytes.length)
	let index = 0
	while (index < limit && leftBytes[index] === rightBytes[index]) index++
	return index
}

function findFirstDivergence(
	previous: readonly SemanticPromptSegment[],
	current: readonly SemanticPromptSegment[],
): MockCacheFirstDivergence | undefined {
	const limit = Math.max(previous.length, current.length)
	let byteOffset = 0
	for (let index = 0; index < limit; index++) {
		const before = previous[index]
		const after = current[index]
		if (before && after && before.component === after.component && before.path === after.path && before.text === after.text) {
			byteOffset += Buffer.byteLength(`${after.component}\u0000${after.path}\u0000${after.text}\u0000`, "utf8")
			continue
		}

		const segment = after ?? before
		if (!segment) return undefined
		const beforeText = before?.text ?? ""
		const afterText = after?.text ?? ""
		if (before && after && before.component === after.component && before.path === after.path) {
			byteOffset += Buffer.byteLength(`${after.component}\u0000${after.path}\u0000`, "utf8")
			byteOffset += firstStringByteDifference(beforeText, afterText)
		}
		return {
			component: segment.component,
			path: segment.path,
			byteOffset,
			estimatedTokenOffset: Math.floor(byteOffset / TOKEN_ESTIMATE_BYTES),
			beforeHash: hashProjection(beforeText),
			afterHash: hashProjection(afterText),
			beforeText,
			afterText,
		}
	}
	return undefined
}

function createWarning(
	code: MockCacheWarningCode,
	message: string,
	target: E2EMockProviderTarget,
	requestIndex: number,
	usage: { totalInputTokens: number; cacheReadTokens: number; previousCacheReadTokens?: number },
): MockCacheWarning {
	return {
		code,
		message,
		target,
		requestIndex,
		...(usage.previousCacheReadTokens === undefined ? {} : { previousCacheReadTokens: usage.previousCacheReadTokens }),
		cacheReadTokens: usage.cacheReadTokens,
		totalInputTokens: usage.totalInputTokens,
	}
}

function hasCachePlateau(observations: readonly CacheObservation[]): boolean {
	if (observations.length < PLATEAU_OBSERVATION_COUNT) return false
	const window = observations.slice(-PLATEAU_OBSERVATION_COUNT)
	const first = window[0]
	const last = window.at(-1)!
	const inputGrowth = last.totalInputTokens - first.totalInputTokens
	const cacheReadValues = window.map(({ cacheReadTokens }) => cacheReadTokens)
	const cacheReadSpread = Math.max(...cacheReadValues) - Math.min(...cacheReadValues)
	return first.cacheReadTokens > 0 && inputGrowth >= PLATEAU_GROWTH_MIN_TOKENS && cacheReadSpread <= CACHE_READ_GROWTH_TOLERANCE
}

/** Track semantic OpenAI prompt prefixes and expose deterministic cache anomaly diagnostics for E2E tests. */
export class OpenAiCacheDiagnostics {
	private readonly states = new Map<E2EMockProviderTarget, TargetCacheState>()
	private readonly warnings: MockCacheWarning[] = []

	/** Derive Provider usage from the previous successful request in the same cache partition. */
	public deriveUsage(
		target: E2EMockProviderTarget,
		protocol: E2EMockApiProtocol,
		requestBody: unknown,
	): DerivedOpenAiCacheUsage | undefined {
		if (!OPENAI_TARGETS.has(target)) return undefined
		const projection = createProjection(protocol, requestBody)
		if (!projection) return undefined
		const state = this.getOrCreateState(target)
		const previous = [...state.observations].reverse().find(({ identity }) => identity === projection.identity)
		const reusablePrefixTokens = previous
			? estimateTokens(projection.promptText.slice(0, commonPrefixLength(previous.promptText, projection.promptText)))
			: 0
		const totalInputTokens = estimateTokens(projection.promptText)
		const cacheReadTokens = Math.min(Math.max(0, totalInputTokens - 2), reusablePrefixTokens)
		const uncachedTokens = Math.max(0, totalInputTokens - cacheReadTokens)
		const cacheWriteTokens = uncachedTokens > 2 ? Math.max(1, Math.floor(uncachedTokens * 0.4)) : 0
		return {
			totalInputTokens,
			reusablePrefixTokens,
			cacheReadTokens,
			cacheWriteTokens,
			inputTokens: Math.max(1, totalInputTokens - cacheReadTokens - cacheWriteTokens),
		}
	}

	public observe(
		target: E2EMockProviderTarget,
		protocol: E2EMockApiProtocol,
		requestBody: unknown,
		usage: OpenAiCacheUsage,
	): MockCacheDiagnostic | undefined {
		if (!OPENAI_TARGETS.has(target)) return undefined
		const projection = createProjection(protocol, requestBody)
		if (!projection) return undefined

		const state = this.getOrCreateState(target)
		const requestIndex = state.observations.length
		const previous = state.observations.at(-1)
		const sameIdentityHistory = state.observations.filter(({ identity }) => identity === projection.identity)
		const previousSameIdentity = sameIdentityHistory.at(-1)
		const reusablePrefixTokens = previousSameIdentity
			? estimateTokens(
					projection.promptText.slice(0, commonPrefixLength(previousSameIdentity.promptText, projection.promptText)),
				)
			: 0
		const totalInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
		const cacheReadTokens = usage.cacheReadTokens ?? 0
		const cacheWriteTokens = usage.cacheWriteTokens ?? 0
		const highWaterPrefix = state.highWaterPrefixByIdentity.get(projection.identity) ?? 0
		const currentWarnings: MockCacheWarning[] = []
		const expectedPrefixHash = previous?.stablePrefixHash
		const prefixHashMatched =
			expectedPrefixHash === undefined ? undefined : expectedPrefixHash === projection.stablePrefixHash
		const matchedPrefixLength = previous ? commonPrefixLength(previous.promptText, projection.promptText) : 0
		const matchedPrefixText = projection.promptText.slice(0, matchedPrefixLength)
		const warningUsage = {
			totalInputTokens,
			cacheReadTokens,
			...(previous ? { previousCacheReadTokens: previous.cacheReadTokens } : {}),
		}

		if (prefixHashMatched === false) {
			currentWarnings.push(
				createWarning(
					"prefix_hash_mismatch",
					`Stable OpenAI system/tools prefix changed from ${expectedPrefixHash} to ${projection.stablePrefixHash}.`,
					target,
					requestIndex,
					warningUsage,
				),
			)
		}

		if (state.lastIdentity && state.lastIdentity !== projection.identity) {
			currentWarnings.push(
				createWarning(
					"identity_changed",
					"OpenAI prompt cache identity changed after a successful request; expect a new cache partition or cold start.",
					target,
					requestIndex,
					warningUsage,
				),
			)
		}

		const regressed =
			sameIdentityHistory.length > 0 &&
			highWaterPrefix >= PREFIX_REGRESSION_MIN_TOKENS &&
			reusablePrefixTokens < highWaterPrefix * PREFIX_REGRESSION_RATIO
		if (regressed) {
			currentWarnings.push(
				createWarning(
					"prefix_regression",
					`Reusable OpenAI prompt prefix regressed from ${highWaterPrefix} to ${reusablePrefixTokens} estimated tokens.`,
					target,
					requestIndex,
					warningUsage,
				),
			)
		}

		const warmMiss = sameIdentityHistory.length > 0 && cacheReadTokens === 0
		if (warmMiss) {
			currentWarnings.push(
				createWarning(
					"warm_cache_miss",
					"OpenAI reported zero cache-read tokens for an identity that already has successful request history.",
					target,
					requestIndex,
					warningUsage,
				),
			)
		}

		const observation: CacheObservation = {
			requestIndex,
			identity: projection.identity,
			promptText: projection.promptText,
			stablePrefixText: projection.stablePrefixText,
			stablePrefixHash: projection.stablePrefixHash,
			promptHash: projection.promptHash,
			segments: projection.segments,
			totalInputTokens,
			reusablePrefixTokens,
			cacheReadTokens,
		}
		state.observations.push(observation)
		state.highWaterPrefixByIdentity.set(projection.identity, Math.max(highWaterPrefix, reusablePrefixTokens))
		state.lastIdentity = projection.identity

		const identityObservations = state.observations.filter(({ identity }) => identity === projection.identity)
		const plateau = hasCachePlateau(identityObservations)
		if (plateau) {
			currentWarnings.push(
				createWarning(
					"cache_plateau",
					`OpenAI cache reads remained near ${cacheReadTokens} tokens while total input grew across ${PLATEAU_OBSERVATION_COUNT} requests.`,
					target,
					requestIndex,
					warningUsage,
				),
			)
		}

		this.warnings.push(...currentWarnings)
		const previousTotalInputTokens = previousSameIdentity?.totalInputTokens
		const previousCacheReadTokens = previousSameIdentity?.cacheReadTokens
		return {
			state: plateau
				? "plateau"
				: prefixHashMatched === false
					? "prefix_mismatch"
					: regressed
						? "regressed"
						: warmMiss
							? "miss"
							: sameIdentityHistory.length === 0
								? "cold"
								: "warm",
			identity: projection.identity,
			requestIndex,
			...(previousSameIdentity ? { previousRequestIndex: previousSameIdentity.requestIndex } : {}),
			totalInputTokens,
			...(previousTotalInputTokens === undefined ? {} : { previousTotalInputTokens }),
			inputGrowthTokens:
				previousTotalInputTokens === undefined ? totalInputTokens : totalInputTokens - previousTotalInputTokens,
			reusablePrefixTokens,
			cacheReadTokens,
			...(previousCacheReadTokens === undefined ? {} : { previousCacheReadTokens }),
			cacheReadGrowthTokens:
				previousCacheReadTokens === undefined ? cacheReadTokens : cacheReadTokens - previousCacheReadTokens,
			cacheWriteTokens,
			componentHashes: projection.componentHashes,
			componentTokenEstimates: projection.componentTokenEstimates,
			componentTexts: projection.componentTexts,
			...(expectedPrefixHash === undefined ? {} : { expectedPrefixHash }),
			actualPrefixHash: projection.stablePrefixHash,
			...(prefixHashMatched === undefined ? {} : { prefixHashMatched }),
			...(previous ? { expectedPrefixBytes: Buffer.byteLength(previous.stablePrefixText, "utf8") } : {}),
			actualPrefixBytes: Buffer.byteLength(projection.stablePrefixText, "utf8"),
			stablePrefixTokens: estimateTokens(projection.stablePrefixText),
			promptHash: projection.promptHash,
			...(previous ? { previousPromptHash: previous.promptHash } : {}),
			...(previous ? { matchedPrefixHash: hashText(matchedPrefixText) } : {}),
			matchedPrefixBytes: Buffer.byteLength(matchedPrefixText, "utf8"),
			...(previousSameIdentity
				? { firstDivergence: findFirstDivergence(previousSameIdentity.segments, projection.segments) }
				: {}),
			projection: projection.projection,
			warnings: currentWarnings,
		}
	}

	public getWarnings(target?: E2EMockProviderTarget): readonly MockCacheWarning[] {
		return target ? this.warnings.filter((warning) => warning.target === target) : this.warnings
	}

	public reset(): void {
		this.states.clear()
		this.warnings.length = 0
	}

	private getOrCreateState(target: E2EMockProviderTarget): TargetCacheState {
		const existing = this.states.get(target)
		if (existing) return existing
		const state: TargetCacheState = {
			observations: [],
			highWaterPrefixByIdentity: new Map<string, number>(),
		}
		this.states.set(target, state)
		return state
	}
}
