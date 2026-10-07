/**
 * `deferred` marks a provider-hosted call the provider announced but will only run at the start of its next
 * response, after the local tool calls of the same turn return their results.
 */
export type WebToolPresentationStatus = "running" | "deferred" | "completed" | "failed"

/** Identity of a deferred hosted call, so the request that resumes it can finish the same row. */
export interface HostedCallPresentation {
	/** Provider-native call id that pairs the call with its result. */
	functionId: string
	/** Dline trace identity the call carries across both responses. */
	traceId: string
}

export interface WebToolSourcePresentation {
	id: string
	label: string
	execution: "hosted" | "dline"
	provider?: string
}

export interface WebSearchItemPresentation {
	url: string
	title?: string
	snippet?: string
}

export type HostedWebSearchOperation =
	| { type: "search"; queries: string[] }
	| { type: "open_page"; url: string }
	| { type: "find_in_page"; url: string; pattern: string }
	| { type: "unknown"; providerType?: string }

export interface WebSearchPresentationV1 {
	schemaVersion: 1
	status: WebToolPresentationStatus
	source?: WebToolSourcePresentation
	query?: string
	operation?: HostedWebSearchOperation
	items?: WebSearchItemPresentation[]
	error?: string
	/** Present only while the row is deferred. */
	hostedCall?: HostedCallPresentation
}

export interface WebFetchPresentationV1 {
	schemaVersion: 1
	status: WebToolPresentationStatus
	source?: WebToolSourcePresentation
	url: string
	prompt?: string
	content?: string
	error?: string
	/** Present only while the row is deferred. */
	hostedCall?: HostedCallPresentation
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function nonEmptyStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.flatMap((item) => {
		const text = nonEmptyString(item)
		return text ? [text] : []
	})
}

/** Normalize a provider-native hosted Web Search action into a stable shared operation. */
export function normalizeHostedWebSearchOperation(value: unknown): HostedWebSearchOperation {
	const record = asRecord(value)
	const action = asRecord(record?.action) ?? record
	if (!action) return { type: "unknown" }

	const providerType = nonEmptyString(action.type)
	if (providerType === "search" || providerType === undefined) {
		const queries = nonEmptyStrings(action.queries)
		const legacyQuery = nonEmptyString(action.query) ?? nonEmptyString(action.q) ?? nonEmptyString(action.search_query)
		if (queries.length > 0 || legacyQuery) {
			return { type: "search", queries: queries.length > 0 ? queries : [legacyQuery!] }
		}
	}

	if (providerType === "open_page") {
		const url = nonEmptyString(action.url)
		if (url) return { type: "open_page", url }
	}

	if (providerType === "find_in_page") {
		const url = nonEmptyString(action.url)
		const pattern = nonEmptyString(action.pattern)
		if (url && pattern) return { type: "find_in_page", url, pattern }
	}

	return {
		type: "unknown",
		...(providerType ? { providerType } : {}),
	}
}

function normalizeSearchItem(value: unknown): WebSearchItemPresentation | undefined {
	const record = asRecord(value)
	if (!record) return undefined

	const url = nonEmptyString(record.url)
	if (!url) return undefined

	const title = nonEmptyString(record.title)
	const snippet = nonEmptyString(record.snippet) ?? nonEmptyString(record.content)
	return {
		url,
		...(title ? { title } : {}),
		...(snippet ? { snippet } : {}),
	}
}

/**
 * Read the fetched page text from a provider-hosted Web Fetch result.
 *
 * Anthropic returns the page as a document whose text source carries the full body. Binary sources such as base64
 * PDFs have no displayable text, so they yield `undefined` rather than raw encoded bytes.
 */
export function normalizeHostedWebFetchContent(result: unknown): string | undefined {
	const content = asRecord(result)?.content
	if (typeof content === "string") return nonEmptyString(content) ? content : undefined

	const source = asRecord(asRecord(content)?.source)
	if (source?.type !== "text" || typeof source.data !== "string") return undefined
	return nonEmptyString(source.data) ? source.data : undefined
}

/** Normalize provider-native and local Web Search payloads before they cross the UI message boundary. */
export function normalizeWebSearchItems(result: unknown): WebSearchItemPresentation[] {
	const record = asRecord(result)
	const action = asRecord(record?.action)
	const candidateGroups: unknown[][] = []
	if (Array.isArray(result)) candidateGroups.push(result)
	if (Array.isArray(record?.items)) candidateGroups.push(record.items)
	if (Array.isArray(record?.results)) candidateGroups.push(record.results)
	if (Array.isArray(record?.sources)) candidateGroups.push(record.sources)
	if (Array.isArray(action?.sources)) candidateGroups.push(action.sources)

	const items: WebSearchItemPresentation[] = []
	const itemIndexes = new Map<string, number>()
	for (const candidate of candidateGroups.flat()) {
		const item = normalizeSearchItem(candidate)
		if (!item) continue

		const existingIndex = itemIndexes.get(item.url)
		if (existingIndex === undefined) {
			itemIndexes.set(item.url, items.length)
			items.push(item)
			continue
		}

		const existing = items[existingIndex]
		items[existingIndex] = {
			url: existing.url,
			...(existing.title || item.title ? { title: existing.title ?? item.title } : {}),
			...(existing.snippet || item.snippet ? { snippet: existing.snippet ?? item.snippet } : {}),
		}
	}
	return items
}
