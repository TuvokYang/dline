const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function encodeTaskPayload<T>(value: T): Uint8Array {
	return encoder.encode(JSON.stringify(value))
}

export function decodeTaskPayload<T>(payload: Uint8Array): T {
	return JSON.parse(decoder.decode(payload)) as T
}
