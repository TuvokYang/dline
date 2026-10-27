/**
 * Conformance of the client contract layer with Usage schema 5 revision 1, whose
 * field set and semantics equal the retired schema 4 revision 5.
 *
 * Expected values come from the vendored dline-web fixtures, not from the
 * implementation: every vector, invalid mutation and boundary case of the
 * fixture is replayed against the client validators and projectors.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { canonicalJson, compareUtf16 } from "../canonicalJson"
import { isUsageModelId, projectUsageModelId } from "../modelIdentity"
import {
    buildReportAuthorizeRequest,
    parseIssuedReportAuthorization,
    parseReportAuthorizationStatus,
} from "../reportAuthorization"
import { deriveSupportCode, isAuthorizationCode, isSupportCode } from "../supportCode"
import { isUsageThinking, projectUsageThinking } from "../thinking"
import {
    canonicalUsageBodyBytes,
    estimateUsageWriteRows,
    orderUsageBody,
    USAGE_HARD_LIMITS,
    type UsageBodyLimits,
    type UsageBodyRule,
    validateUsageBodySchema,
} from "../usageBodySchema"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

interface PatchOperation {
    readonly op: "add" | "remove" | "replace"
    readonly path: string
    readonly value?: Json
}

interface FixtureCase {
    readonly name: string
    readonly mutations?: readonly PatchOperation[]
    readonly expected: { readonly status: number; readonly code?: string; readonly path?: string; readonly invariant?: string }
}

interface BoundaryCase {
    readonly name: string
    readonly dimension: string
    readonly value?: number
    readonly expected_status: number
    readonly expected_code?: string
    readonly grant?: number
    readonly grant_max_write_rows?: number
    readonly reasoning?: number
    readonly generation_output?: number
    readonly output?: number
}

const FIXTURE_DIRECTORY = path.join(__dirname, "fixtures")
// The sibling dline-web checkout owns the fixtures; CI checks out only this repository.
const SOURCE_DIRECTORY = path.resolve(__dirname, "..", "..", "..", "..", "..", "..", "..", "dline-web", "docs", "fixtures")
const VENDORED_FILES = [
    "usage-schema4-reference.json",
    "report-authorization-reference.json",
    "otlp-production-reference.json",
] as const
const CLIENT_VERSION = "0.12.0"
const EMPTY_HISTOGRAM = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

function readFixtureText(directory: string, name: string): string {
    return readFileSync(path.join(directory, name), "utf8").replace(/\r\n/g, "\n")
}

const usageFixture = JSON.parse(readFixtureText(FIXTURE_DIRECTORY, "usage-schema4-reference.json"))
const authorizationFixture = JSON.parse(readFixtureText(FIXTURE_DIRECTORY, "report-authorization-reference.json"))

const baseRequest = usageFixture.valid_requests[0] as { headers: Record<string, string>; body: JsonObject }
const grantContract = usageFixture.device_grant.response.usage_contract
const grantLimits: UsageBodyLimits = {
    maxBodyBytes: grantContract.max_body_bytes,
    maxBuckets: grantContract.max_buckets,
    maxFacts: grantContract.max_facts,
    maxToolRows: grantContract.max_tool_rows,
    maxWriteRows: grantContract.max_write_rows,
}

/** Client version the request's User-Agent carries; `client.version` must equal it. */
function userAgentVersion(headers: Record<string, string>): string {
    const match = /^Dline\/(.+)$/.exec(headers["user-agent"])
    if (!match) throw new Error("fixture user-agent is not a Dline user agent")
    return match[1]
}

/** Fixture mutations use the RFC 6902 subset add/remove/replace over JSON pointers. */
function applyPatch<T extends Json>(document: T, operations: readonly PatchOperation[]): T {
    const copy = structuredClone(document)
    for (const operation of operations) {
        const segments = operation.path
            .split("/")
            .slice(1)
            .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
        const key = segments.pop()
        if (key === undefined) throw new Error(`fixture patch path ${operation.path} has no target`)
        let parent = copy as Json
        for (const segment of segments) {
            parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as JsonObject)[segment]
        }
        if (Array.isArray(parent)) {
            const index = Number(key)
            if (operation.op === "remove") parent.splice(index, 1)
            else if (operation.op === "add") parent.splice(index, 0, structuredClone(operation.value as Json))
            else parent[index] = structuredClone(operation.value as Json)
        } else if (operation.op === "remove") {
            delete (parent as JsonObject)[key]
        } else {
            ;(parent as JsonObject)[key] = structuredClone(operation.value as Json)
        }
    }
    return copy
}

function mutatedRequest(fixtureCase: FixtureCase): { headers: Record<string, string>; body: JsonObject } {
    const document = applyPatch(baseRequest as unknown as Json, fixtureCase.mutations ?? []) as unknown as {
        headers: Record<string, string>
        body: JsonObject
    }
    return document
}

function validate(request: { headers: Record<string, string>; body: unknown }, limits: UsageBodyLimits = grantLimits) {
    return validateUsageBodySchema(request.body, { limits, clientVersion: userAgentVersion(request.headers) })
}

/**
 * Fixture invariants are prose; this table states which client rule each one is.
 * A new fixture invariant fails the test until it is mapped deliberately.
 */
const INVARIANT_RULES: Readonly<Record<string, UsageBodyRule>> = {
    "token_coverage.reported + token_coverage.unreported == requests.total": "token_coverage_total",
    "duration_ms.count == requests.total": "duration_count",
    "bucket.duration_ms == sum(facts[*].duration_ms.sum)": "bucket_duration",
    "generation coverage requires reported token usage": "generation_requires_tokens",
    "every real provider attempt duration is at least 1 ms": "duration_minimum",
    "logical_execution outcome total == task_attempts.count == logical_execution_coverage.reported": "logical_coverage",
    "task_attempts.count == logical_requests.total": "task_attempts_count",
    "generation_ms.count == generation_coverage.reported": "generation_coverage_count",
    "sum(errors[*]) == requests.failed": "error_conservation",
}

describe("vendored contract fixtures", () => {
    // Compared as JSON values so formatting and line endings never count as drift.
    describe.runIf(existsSync(SOURCE_DIRECTORY))("with a dline-web checkout", () => {
        it.each(VENDORED_FILES)("%s is identical to the dline-web source", (name) => {
            expect(JSON.parse(readFixtureText(FIXTURE_DIRECTORY, name))).toEqual(
                JSON.parse(readFixtureText(SOURCE_DIRECTORY, name)),
            )
        })
    })
})

describe("model identity projection", () => {
    it.each(
        usageFixture.model_identity_vectors as {
            name: string
            wire_model_id: string | null
            profile_custom_model: boolean
            expected: string
        }[],
    )("$name", (vector) => {
        const projected = projectUsageModelId(vector.wire_model_id, { customModel: vector.profile_custom_model })
        expect(projected).toBe(vector.expected)
        expect(isUsageModelId(projected)).toBe(true)
    })

    it("truncates a normalized ID to 96 characters", () => {
        expect(projectUsageModelId("a".repeat(120), { customModel: true })).toBe(`custom:${"a".repeat(96)}`)
    })

    it.each([
        "./model.gguf",
        "../model.gguf",
        "file:model.gguf",
        "D:/models/x",
        "models\\x",
        " /srv/model ",
    ])("never discloses the path-shaped value %j", (value) => {
        expect(projectUsageModelId(value, { customModel: true })).toBe("state:private")
        expect(projectUsageModelId(value, { customModel: false })).toBe("state:private")
    })

    it("rejects identities outside the revision 5 namespaces", () => {
        for (const value of ["custom:Qwen3", "local:qwen3", "catalog:", "state:other", `catalog:${"a".repeat(97)}`]) {
            expect(isUsageModelId(value)).toBe(false)
        }
    })
})

describe("thinking mapping", () => {
    it.each(
        usageFixture.thinking_vectors as { name: string; request: unknown; expected: number | string }[],
    )("$name", (vector) => {
        const projected = projectUsageThinking(vector.request)
        expect(projected).toBe(vector.expected)
        expect(isUsageThinking(projected)).toBe(true)
    })

    it.each([
        ["budget wins over effort", { thinking: { type: "enabled", budget_tokens: 512 }, reasoning_effort: "high" }, 512],
        ["responses reasoning effort", { reasoning: { effort: "low" } }, "level:low"],
        ["gemini thinking level", { generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } }, "level:high"],
        ["level characters are normalized", { reasoning_effort: "Extra High!" }, "level:extra_high_"],
        ["level is truncated to 32 characters", { reasoning_effort: "x".repeat(40) }, `level:${"x".repeat(32)}`],
        ["think false is off", { think: false }, "state:off"],
        ["out-of-range budget is unreadable", { thinking: { type: "enabled", budget_tokens: -2 } }, "state:unknown"],
        ["unrecognized thinking type is unreadable", { thinking: { type: "turbo" } }, "state:unknown"],
    ] as const)("%s", (_name, request, expected) => {
        expect(projectUsageThinking(request)).toBe(expected)
    })

    it("rejects values outside the mapping table", () => {
        for (const value of ["state:enabled", "state:disabled", "state:adaptive", "level:", "level:UP", -0, -2, 1.5]) {
            expect(isUsageThinking(value)).toBe(false)
        }
    })
})

describe("canonical JSON", () => {
    it("orders properties by UTF-16 code units (RFC 8785 §3.2.3)", () => {
        const input = {
            "\u20ac": "Euro Sign",
            "\r": "Carriage Return",
            "\ufb33": "Hebrew Letter Dalet With Dagesh",
            "1": "One",
            "\ud83d\ude00": "Emoji: Grinning Face",
            "\u0080": "Control",
            "\u00f6": "Latin Small Letter O With Diaeresis",
        }
        expect(canonicalJson(input)).toBe(
            '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
                '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
        )
    })

    it("serializes literals, safe integers and escapes like RFC 8785", () => {
        expect(
            canonicalJson({
                string: '\u20ac$\u000f\nA\'B"\\\\"/',
                numbers: [0, -0, 9007199254740991],
                literals: [null, true, false],
            }),
        ).toBe('{"literals":[null,true,false],"numbers":[0,0,9007199254740991],"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}')
    })

    it.each([2048.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "\ud800"])("rejects the non-canonical value %j", (value) => {
        expect(() => canonicalJson({ value })).toThrow()
    })

    it("compares strings by code unit rather than locale collation", () => {
        expect(compareUtf16("model-a", "model_a")).toBeLessThan(0)
        expect(compareUtf16("\ud83d\ude00", "\ufb33")).toBeLessThan(0)
        expect(compareUtf16("same", "same")).toBe(0)
    })
})

describe("schema 5 request body", () => {
    it("accepts the reference request with its logical write rows", () => {
        expect(validate(baseRequest)).toEqual([])
        expect(estimateUsageWriteRows(baseRequest.body)).toBe(usageFixture.valid_requests[0].expected.logical_write_rows)
    })

    it.each(usageFixture.identity_cases as FixtureCase[])("accepts identity case $name", (fixtureCase) => {
        expect(validate(mutatedRequest(fixtureCase))).toEqual([])
    })

    it.each(usageFixture.invalid_cases as FixtureCase[])("rejects invalid case $name", (fixtureCase) => {
        const violations = validate(mutatedRequest(fixtureCase))
        const { code, path: contractPath, invariant } = fixtureCase.expected
        if (contractPath !== undefined) {
            expect(violations).toContainEqual(expect.objectContaining({ code, path: contractPath }))
        } else {
            expect(invariant).toBeDefined()
            const rule = INVARIANT_RULES[invariant as string]
            expect(rule, `fixture invariant "${invariant}" has no client rule`).toBeDefined()
            expect(violations).toContainEqual(expect.objectContaining({ code, rule }))
        }
    })

    it.each(usageFixture.boundary_cases as BoundaryCase[])("boundary $name", (boundary) => {
        const { body, limits } = boundaryRequest(boundary)
        const violations = validateUsageBodySchema(body, { limits, clientVersion: CLIENT_VERSION })
        if (boundary.expected_status === 200) {
            expect(violations).toEqual([])
        } else {
            expect(violations).toContainEqual(expect.objectContaining({ code: boundary.expected_code }))
        }
    })

    it("caps a generous grant at the schema 5 hard limits", () => {
        const body = bodyOf([boundaryFact(0)])
        const size = canonicalUsageBodyBytes(body).byteLength
        const generous = { ...grantLimits, maxBodyBytes: 10 * USAGE_HARD_LIMITS.maxBodyBytes, maxFacts: 1000 }
        expect(
            validateUsageBodySchema(body, { limits: { ...generous, maxBodyBytes: size }, clientVersion: CLIENT_VERSION }),
        ).toEqual([])
        const facts = Array.from({ length: USAGE_HARD_LIMITS.maxFacts + 1 }, (_, index) => boundaryFact(index))
        expect(validateUsageBodySchema(bodyOf(facts), { limits: generous, clientVersion: CLIENT_VERSION })).toContainEqual(
            expect.objectContaining({ code: "invalid_usage_body", rule: "capacity" }),
        )
    })
})

describe("semantic order of the canonical body", () => {
    it("orders facts by role, provider, model ID and thinking with numbers first", () => {
        const ordered = orderUsageBody(baseRequest.body) as { buckets: { facts: { thinking: Json }[] }[] }
        expect(ordered.buckets[0].facts.map((fact) => fact.thinking)).toEqual([2048, "level:high", "state:dynamic"])
    })

    it("produces identical bytes for any input order", () => {
        const reversed = structuredClone(baseRequest.body) as { buckets: { facts: Json[] }[] }
        reversed.buckets[0].facts.reverse()
        expect(
            Buffer.from(canonicalUsageBodyBytes(reversed)).equals(Buffer.from(canonicalUsageBodyBytes(baseRequest.body))),
        ).toBe(true)
    })

    it("uses code-unit order for model IDs and bucket IDs", () => {
        const underscore = { ...boundaryFact(0), model_id: "catalog:model_a" }
        const hyphen = { ...boundaryFact(0), model_id: "catalog:model-a" }
        const body = {
            schema_version: 5,
            client: { version: CLIENT_VERSION },
            buckets: [bucketOf("bucket_b", [underscore, hyphen]), bucketOf("bucket-b", [boundaryFact(1)])],
        }
        const ordered = orderUsageBody(body) as unknown as { buckets: { bucket_id: string; facts: { model_id: string }[] }[] }
        expect(ordered.buckets.map((bucket) => bucket.bucket_id)).toEqual(["bucket-b", "bucket_b"])
        expect(ordered.buckets[1].facts.map((fact) => fact.model_id)).toEqual(["catalog:model-a", "catalog:model_a"])
    })
})

describe("report authorization", () => {
    const vector = authorizationFixture.report_authorization.support_code_vector
    const create = authorizationFixture.report_authorization.create
    const status = authorizationFixture.report_authorization.status

    it("derives the fixture public code from the authorization code", () => {
        expect(deriveSupportCode(vector.authorization_code)).toBe(vector.public_code)
        expect(isSupportCode(vector.public_code)).toBe(true)
    })

    it("rejects malformed authorization codes", () => {
        for (const value of ["s".repeat(42), "s".repeat(44), `${"s".repeat(42)}+`, `${"s".repeat(42)}=`]) {
            expect(isAuthorizationCode(value)).toBe(false)
            expect(() => deriveSupportCode(value)).toThrow()
        }
    })

    it("builds the fixture issuance body", () => {
        const body = create.request.body
        expect(buildReportAuthorizeRequest(body.request_id, CLIENT_VERSION, body.platform)).toEqual(body)
    })

    it("reads the fixture issuance response for its own request ID only", () => {
        const body = create.response.body
        expect(parseIssuedReportAuthorization(body, body.request_id)).toEqual({
            authorizationCode: body.authorization_code,
            state: "awaiting_issue",
            authorizationExpiresAt: body.authorization_expires_at,
            ticketExpiresAt: body.ticket_expires_at,
            pollAfterMs: body.poll_after_ms,
        })
        expect(parseIssuedReportAuthorization(body, "99999999-9999-4999-8999-999999999999")).toBeUndefined()
        expect(
            parseIssuedReportAuthorization({ ...body, ticket_expires_at: body.authorization_expires_at - 1 }, body.request_id),
        ).toBeUndefined()
    })

    it("reads the fixture status and projects none of the forbidden Issue fields", () => {
        const body = status.response.body
        const leaked = Object.fromEntries(status.forbidden_response_fields.map((field: string) => [field, "leak"]))
        const parsed = parseReportAuthorizationStatus({ ...body, ...leaked })
        expect(parsed).toEqual({
            state: "approved",
            revision: body.authorization_revision,
            authorizationExpiresAt: body.authorization_expires_at,
            captureExpiresAt: body.capture_expires_at,
            ticketExpiresAt: body.ticket_expires_at,
            issueState: "open",
            resolution: { state: "investigating" },
            pollAfterMs: body.poll_after_ms,
        })
    })

    it("rejects an approved status without a capture window or with an unknown resolution", () => {
        const body = status.response.body
        expect(parseReportAuthorizationStatus({ ...body, capture_expires_at: undefined })).toBeUndefined()
        expect(parseReportAuthorizationStatus({ ...body, resolution: { state: "resolved" } })).toBeUndefined()
        expect(
            parseReportAuthorizationStatus({ ...body, resolution: { state: "fixed", summary: "x".repeat(501) } }),
        ).toBeUndefined()
    })
})

function histogramOf(bucket: number): number[] {
    return EMPTY_HISTOGRAM.map((_, index) => (index === bucket ? 1 : 0))
}

function namedTools(count: number): JsonObject {
    const byName: JsonObject = {}
    for (let index = 1; index <= count; index++) {
        byName[`tool_${String(index).padStart(2, "0")}`] = { completed: 1, failed: 0, cancelled: 0 }
    }
    return { completed: count, failed: 0, cancelled: 0, by_name: byName, unlisted: { completed: 0, failed: 0, cancelled: 0 } }
}

/** One valid single-attempt fact; `index` makes the thinking budget, and so the identity, unique. */
function boundaryFact(index: number, options: { readonly tools?: number } = {}): JsonObject {
    const execution = options.tools !== undefined
    return {
        role: "task",
        provider: "anthropic",
        model_id: "catalog:model-a",
        thinking: index + 1,
        requests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 },
        tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 0 },
        token_coverage: { reported: 1, unreported: 0 },
        generation_coverage: { reported: 0, unreported: 1 },
        logical_execution_coverage: { reported: execution ? 1 : 0, unreported: 0 },
        generation_output_tokens: 0,
        duration_ms: { count: 1, sum: 100, min: 100, max: 100, buckets: histogramOf(0) },
        errors: {},
        ...(execution
            ? {
                  logical_execution: {
                      logical_requests: { completed: 1, failed: 0, cancelled: 0, aborted: 0 },
                      turn_duration_ms: { count: 1, sum: 100, min: 100, max: 100 },
                      ...(options.tools ? { tools: namedTools(options.tools) } : {}),
                      task_attempts: { count: 1, sum: 1, min: 1, max: 1 },
                  },
              }
            : {}),
    }
}

function bucketOf(bucketId: string, facts: JsonObject[]): JsonObject {
    const duration = facts.reduce((sum, fact) => sum + ((fact.duration_ms as JsonObject).sum as number), 0)
    return {
        bucket_id: bucketId,
        policy_epoch: 1,
        event_window: {
            started_at: 1792800000000,
            ended_at: 1792800600000,
            first_attempt_at: 1792800000000,
            last_attempt_at: 1792800000000,
            sealed_at: 1792800000001,
        },
        duration_ms: duration,
        sessions_started: 1,
        facts,
    }
}

function bodyOf(facts: JsonObject[], bucketIds: readonly string[] = ["bucket-1"]): JsonObject {
    const perBucket = Math.ceil(facts.length / bucketIds.length)
    return {
        schema_version: 5,
        client: { version: CLIENT_VERSION, platform: "win32" },
        buckets: bucketIds.map((bucketId, index) => bucketOf(bucketId, facts.slice(index * perBucket, (index + 1) * perBucket))),
    }
}

/** Facts with logical execution whose named tools add up to `total`, at most 12 per fact. */
function factsWithTools(factCount: number, total: number): JsonObject[] {
    let remaining = total
    return Array.from({ length: factCount }, (_, index) => {
        const tools = Math.min(12, remaining)
        remaining -= tools
        return boundaryFact(index, { tools })
    })
}

function boundaryRequest(boundary: BoundaryCase): { readonly body: JsonObject; readonly limits: UsageBodyLimits } {
    const value = boundary.value ?? 0
    switch (boundary.dimension) {
        case "facts":
            return { body: bodyOf(Array.from({ length: value }, (_, index) => boundaryFact(index))), limits: grantLimits }
        case "named_tools_per_fact":
            return { body: bodyOf([boundaryFact(0, { tools: value })]), limits: grantLimits }
        case "named_tools_total": {
            const facts = factsWithTools(Math.ceil(value / 12), value)
            return { body: bodyOf(facts), limits: { ...grantLimits, maxWriteRows: boundary.grant_max_write_rows ?? 0 } }
        }
        case "canonical_body_bytes": {
            // The reference grant equals the hard limit, so the boundary is exercised
            // relative to the measured size of a real body rather than by padding.
            const body = bodyOf([boundaryFact(0)])
            const size = canonicalUsageBodyBytes(body).byteLength
            const atLimit = value === USAGE_HARD_LIMITS.maxBodyBytes
            return { body, limits: { ...grantLimits, maxBodyBytes: atLimit ? size : size - 1 } }
        }
        case "any_counter_after_accumulation": {
            const fact = boundaryFact(0)
            fact.tokens = { ...(fact.tokens as JsonObject), input: value }
            return { body: bodyOf([fact]), limits: grantLimits }
        }
        case "tokens.reasoning<=tokens.output": {
            const fact = boundaryFact(0)
            fact.tokens = { ...(fact.tokens as JsonObject), output: boundary.output ?? 0, reasoning: boundary.reasoning ?? 0 }
            return { body: bodyOf([fact]), limits: grantLimits }
        }
        case "generation_output_tokens<=tokens.output": {
            const fact = boundaryFact(0)
            fact.tokens = { ...(fact.tokens as JsonObject), output: boundary.output ?? 0 }
            fact.generation_coverage = { reported: 1, unreported: 0 }
            fact.generation_ms = { count: 1, sum: 50, min: 50, max: 50, buckets: histogramOf(0) }
            fact.generation_output_tokens = boundary.generation_output ?? 0
            return { body: bodyOf([fact]), limits: grantLimits }
        }
        case "logical_write_rows": {
            // 30 facts with execution cost 6 + 2*30 + 30 rows; named tools supply the rest.
            const facts = factsWithTools(30, value - 96)
            return { body: bodyOf(facts), limits: { ...grantLimits, maxWriteRows: boundary.grant ?? 0 } }
        }
        case "duplicate_bucket_ids_in_one_request": {
            const ids = value === 0 ? ["bucket-1", "bucket-2"] : ["bucket-1", "bucket-1"]
            return { body: bodyOf([boundaryFact(0), boundaryFact(1)], ids), limits: grantLimits }
        }
        case "6 + 2*facts + execution_rows + named_tool_rows":
            return { body: bodyOf(factsWithTools(32, 384)), limits: { ...grantLimits, maxWriteRows: boundary.grant ?? 0 } }
        default:
            throw new Error(`fixture boundary dimension "${boundary.dimension}" has no client builder`)
    }
}
