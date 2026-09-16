import { TELEMETRY_MASK_VALUE } from "../service/pipeline-port"
import type { NormalizedRuntimeError } from "./types"

/** Canonical exception fields shared by logs and spans. */
export const EXCEPTION_ATTRIBUTE_KEYS = {
	type: "exception.type",
	message: "exception.message",
	stacktrace: "exception.stacktrace",
	fingerprint: "dline.exception.fingerprint",
	code: "dline.exception.code",
	status: "dline.exception.status",
} as const

/** Accept bounded symbolic identifiers, not provider prose, URLs or credential-shaped values. */
export function readErrorIdentifier(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) return undefined
	if (/^(?:sk[-_]|pk[-_]|gh[pousr]_|github_pat_|eyJ)/i.test(value)) return undefined
	return value
}

export function exceptionAttributes(error: NormalizedRuntimeError): Record<string, string | number> {
	return {
		[EXCEPTION_ATTRIBUTE_KEYS.type]: error.name,
		[EXCEPTION_ATTRIBUTE_KEYS.message]: TELEMETRY_MASK_VALUE,
		[EXCEPTION_ATTRIBUTE_KEYS.fingerprint]: error.fingerprint,
		"dline.exception.fingerprint_version": 2,
		...(error.code === undefined ? {} : { [EXCEPTION_ATTRIBUTE_KEYS.code]: error.code }),
		...(error.status === undefined
			? {}
			: { [EXCEPTION_ATTRIBUTE_KEYS.status]: error.status, "http.response.status_code": error.status }),
		...(error.sourceFrame === undefined ? {} : { [EXCEPTION_ATTRIBUTE_KEYS.stacktrace]: error.sourceFrame }),
	}
}
