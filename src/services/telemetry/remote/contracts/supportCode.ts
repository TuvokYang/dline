/**
 * Report Authorization material (telemetry-exchange-flow §5.1).
 *
 * OTel issues the authorization code; it is the only credential, kept in the
 * owner-only store and sent only to the status query and `/auth/exchange`. The
 * public support code is derived from it one way and is what the Issue
 * carries: OTel derives the same code at issuance and matches the Issue against
 * it, so the code proves nothing on its own and reveals nothing of the secret.
 */

import { createHash } from "node:crypto"

const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const SUPPORT_CODE_PATTERN = /^DLN-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/u
const SUPPORT_CODE_DOMAIN = "dline-otel-support-code-v1:"
const SUPPORT_CODE_DIGEST_BYTES = 10
const SUPPORT_CODE_SYMBOLS = 16
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** 32 CSPRNG bytes from OTel as unpadded base64url (43 characters). */
export function isAuthorizationCode(value: unknown): value is string {
    return typeof value === "string" && AUTHORIZATION_CODE_PATTERN.test(value)
}

export function isSupportCode(value: unknown): value is string {
    return typeof value === "string" && SUPPORT_CODE_PATTERN.test(value)
}

/**
 * `DLN-` plus the big-endian Crockford Base32 form of the first 10 bytes of
 * SHA-256 over the domain-separated authorization code, grouped 4-4-4-4.
 */
export function deriveSupportCode(authorizationCode: string): string {
    if (!isAuthorizationCode(authorizationCode)) throw new TypeError("Invalid authorization code")
    const digest = createHash("sha256").update(`${SUPPORT_CODE_DOMAIN}${authorizationCode}`, "utf8").digest()
    const symbols = encodeCrockford(digest.subarray(0, SUPPORT_CODE_DIGEST_BYTES))
    return `DLN-${symbols.match(/.{4}/gu)?.join("-")}`
}

function encodeCrockford(bytes: Uint8Array): string {
    let value = 0n
    for (const byte of bytes) value = (value << 8n) | BigInt(byte)
    let output = ""
    for (let index = 0; index < SUPPORT_CODE_SYMBOLS; index++) {
        const shift = BigInt((SUPPORT_CODE_SYMBOLS - 1 - index) * 5)
        output += CROCKFORD_ALPHABET[Number((value >> shift) & 31n)]
    }
    return output
}
