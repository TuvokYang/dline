/**
 * Schema 5 revision 1 projection of sealed attempt buckets into the schema 5
 * `/usage` body (usage-contract §14). Validation, the semantic array order and
 * the canonical bytes belong to `usageBodySchema.ts`; this module only shapes
 * the wire from buckets that already passed bucket validation.
 */

import type { AttemptBucket, AttemptDistribution, AttemptFactAggregate } from "../usage/attemptBucket"
import type { UsageGrantContract } from "./deviceGrant"
import {
    orderUsageBody,
    USAGE_HOST_EDITORS,
    USAGE_RELEASE_CHANNELS,
    USAGE_SCHEMA_VERSION,
    type UsageHostEditor,
    type UsageReleaseChannel,
    type UsageRole,
} from "./usageBodySchema"
import type { UsageTaskAttemptsWire, UsageToolsWire } from "./usageExecution"

const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/u
const CLIENT_FIELD_PATTERN = /^[A-Za-z0-9_.+ -]{1,64}$/u

export interface UsageSummaryWire {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
}

export interface UsageDistributionWire extends UsageSummaryWire {
    readonly buckets: readonly number[]
}

export interface UsageCoverageWire {
    readonly reported: number
    readonly unreported: number
}

export interface UsageOutcomeCountsWire {
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
    readonly aborted: number
}

export interface UsageClientWire {
    readonly version: string
    readonly platform?: string
    readonly architecture?: string
    readonly host_version?: string
    readonly host_editor?: UsageHostEditor
    readonly channel?: UsageReleaseChannel
    readonly is_dev?: boolean
}

export interface UsageLogicalExecutionWire {
    readonly logical_requests: UsageOutcomeCountsWire
    readonly turn_duration_ms: UsageSummaryWire
    readonly tools?: UsageToolsWire
    readonly task_attempts: UsageTaskAttemptsWire
}

export interface UsageFactWire {
    readonly role: UsageRole
    readonly provider: string
    readonly model_id: string
    readonly thinking: string | number
    readonly requests: UsageOutcomeCountsWire
    readonly tokens: {
        readonly input: number
        readonly output: number
        readonly cache_read: number
        readonly cache_write: number
        readonly reasoning: number
    }
    readonly token_coverage: UsageCoverageWire
    /** Attempts whose generation phase was measured; the rest are unreported, never zero-duration. */
    readonly generation_coverage: UsageCoverageWire
    /** Result-producing logical requests with (`reported`) and without an attached execution at seal. */
    readonly logical_execution_coverage: UsageCoverageWire
    readonly generation_output_tokens: number
    readonly duration_ms: UsageDistributionWire
    readonly ttft_ms?: UsageDistributionWire
    readonly generation_ms?: UsageDistributionWire
    readonly errors: Readonly<Record<string, number>>
    readonly logical_execution?: UsageLogicalExecutionWire
}

export interface UsageBucketWire {
    readonly bucket_id: string
    readonly policy_epoch: number
    readonly event_window: {
        readonly started_at: number
        readonly ended_at: number
        readonly first_attempt_at: number
        readonly last_attempt_at: number
        readonly sealed_at: number
    }
    readonly duration_ms: number
    readonly sessions_started: number
    readonly facts: readonly UsageFactWire[]
}

export interface UsageBodyWire {
    readonly schema_version: typeof USAGE_SCHEMA_VERSION
    readonly client: UsageClientWire
    readonly buckets: readonly UsageBucketWire[]
}

/** The device grant capability a batch is built under; the schema hard limits still cap it. */
export interface UsageBodyGrant {
    readonly contract: UsageGrantContract
}

/** Keep only the client fields the service accepts; an odd host value is left out instead of refusing every batch. */
export function sanitizeUsageClient(
    client: {
        readonly [K in keyof UsageClientWire]?: unknown
    },
): UsageClientWire | undefined {
    if (typeof client.version !== "string" || !CLIENT_VERSION_PATTERN.test(client.version)) return undefined
    const text = (value: unknown) => (typeof value === "string" && CLIENT_FIELD_PATTERN.test(value) ? value : undefined)
    const platform = text(client.platform)
    const architecture = text(client.architecture)
    const hostVersion = text(client.host_version)
    const hostEditor = USAGE_HOST_EDITORS.find((editor) => editor === client.host_editor)
    const channel = USAGE_RELEASE_CHANNELS.find((name) => name === client.channel)
    return {
        version: client.version,
        ...(platform ? { platform } : {}),
        ...(architecture ? { architecture } : {}),
        ...(hostVersion ? { host_version: hostVersion } : {}),
        ...(hostEditor ? { host_editor: hostEditor } : {}),
        ...(channel ? { channel } : {}),
        ...(typeof client.is_dev === "boolean" ? { is_dev: client.is_dev } : {}),
    }
}

/** Build the body of sealed buckets in the semantic order canonicalization expects. */
export function buildUsageBody(buckets: readonly AttemptBucket[], client: UsageClientWire): UsageBodyWire {
    return orderUsageBody<UsageBodyWire>({
        schema_version: USAGE_SCHEMA_VERSION,
        client,
        buckets: buckets.map(toBucketWire),
    })
}

function toBucketWire(bucket: AttemptBucket): UsageBucketWire {
    if (bucket.sealedAt === undefined) throw new Error("A usage request contains only sealed buckets")
    return {
        bucket_id: bucket.bucketId,
        policy_epoch: bucket.policyGeneration,
        event_window: {
            started_at: bucket.windowStartedAt,
            ended_at: bucket.windowEndedAt,
            first_attempt_at: bucket.firstAttemptAt,
            last_attempt_at: bucket.lastAttemptAt,
            sealed_at: bucket.sealedAt,
        },
        duration_ms: bucket.durationMs,
        sessions_started: bucket.sessionsStarted,
        facts: bucket.facts.map(toFactWire),
    }
}

function toFactWire(fact: AttemptFactAggregate): UsageFactWire {
    const execution = fact.logicalExecution
    return {
        role: fact.identity.role,
        provider: fact.identity.provider,
        model_id: fact.identity.modelId,
        thinking: fact.identity.thinking,
        requests: { ...fact.requests },
        tokens: {
            input: fact.tokens.input,
            output: fact.tokens.output,
            cache_read: fact.tokens.cacheRead,
            cache_write: fact.tokens.cacheWrite,
            reasoning: fact.tokens.reasoning,
        },
        token_coverage: { ...fact.tokenCoverage },
        generation_coverage: { ...fact.generationCoverage },
        logical_execution_coverage: { ...fact.logicalExecutionCoverage },
        generation_output_tokens: fact.generationOutputTokens,
        duration_ms: toDistributionWire(fact.duration),
        ...(fact.ttft ? { ttft_ms: toDistributionWire(fact.ttft) } : {}),
        ...(fact.generation ? { generation_ms: toDistributionWire(fact.generation) } : {}),
        errors: { ...fact.errors },
        ...(execution
            ? {
                  logical_execution: {
                      logical_requests: { ...execution.logicalRequests },
                      turn_duration_ms: { ...execution.turnDurationMs },
                      ...(execution.tools ? { tools: execution.tools } : {}),
                      task_attempts: { ...execution.taskAttempts },
                  },
              }
            : {}),
    }
}

function toDistributionWire(distribution: AttemptDistribution): UsageDistributionWire {
    return {
        count: distribution.count,
        sum: distribution.sum,
        min: distribution.min,
        max: distribution.max,
        buckets: [...distribution.buckets],
    }
}
