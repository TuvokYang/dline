import type { ArtifactResolver } from "@core/artifacts/ArtifactResolver"
import type { ImageArtifact } from "@core/artifacts/TaskArtifactStore"
import type {
    ImageGenerationBudget,
    ImageGenerationExecutionContext,
    ImageGenerationPreview,
    ImageGenerationRequest,
    ImageGenerationUsage,
} from "./contracts"
import { ImageGenerationError } from "./contracts"
import type { ImageGenerationAdapterRegistry } from "./ImageGenerationAdapterRegistry"
import type { ImageGenerationBudgetReservationInput } from "./ImageGenerationBudgetLedger"
import type { ImageGenerationPolicy } from "./ImageGenerationPolicy"
import type { ImageProfileResolver, ResolvedImageProfile } from "./ImageProfileResolver"

export interface ImageGenerationServiceContext extends ImageGenerationExecutionContext {
    budget?: ImageGenerationBudget
}

export interface ImageGenerationResult {
    requestId: string
    profileId: string
    providerId: string
    modelId: string
    artifacts: ImageArtifact[]
    usage: ImageGenerationUsage
}

interface ArtifactPersistenceBoundary {
    persistProviderOutputs: ArtifactResolver["persistProviderOutputs"]
    resolveImage?: ArtifactResolver["resolveImage"]
}

interface ImagePreviewPersistenceBoundary {
    persistPreview(requestId: string, sequence: number, base64: string): Promise<ImageGenerationPreview>
    clearRequest(requestId: string): Promise<void>
}

interface ImageGenerationBudgetBoundary {
    reserve(input: ImageGenerationBudgetReservationInput): Promise<void>
    settle(requestId: string): Promise<void>
    release(requestId: string): Promise<void>
}

export interface ImageGenerationServiceOptions {
    profileResolver: Pick<ImageProfileResolver, "resolve" | "hasAvailableProfile">
    adapterRegistry: ImageGenerationAdapterRegistry
    policy: ImageGenerationPolicy
    artifactResolver: ArtifactPersistenceBoundary
    previewStore?: ImagePreviewPersistenceBoundary
    budgetLedger?: ImageGenerationBudgetBoundary
    isFeatureEnabled?: () => boolean
}

const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 180_000
const DEFAULT_MAX_CONCURRENT_IMAGE_REQUESTS = 1
const MAX_IMAGE_GENERATION_TIMEOUT_MS = 30 * 60_000
const MAX_CONCURRENT_IMAGE_REQUESTS = 8

interface ExecutionSignal {
    signal: AbortSignal
    didTimeout(): boolean
    dispose(): void
}

function invalidExecutionSetting(message: string): ImageGenerationError {
    return new ImageGenerationError({ code: "invalid_request", message, retryable: false })
}

function positiveIntegerSetting(value: number | undefined, fallback: number, name: string, maximum: number): number {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
        throw invalidExecutionSetting(`Image generation ${name} must be an integer between 1 and ${maximum}.`)
    }
    return resolved
}

function taskBudgetSetting(value: number | undefined): number | undefined {
    if (value === undefined) return undefined
    if (!Number.isFinite(value) || value < 0) {
        throw invalidExecutionSetting("Image generation task budget must be a finite non-negative number.")
    }
    return value
}

function createExecutionSignal(parent: AbortSignal, timeoutMs: number): ExecutionSignal {
    const controller = new AbortController()
    let timedOut = false
    const abortFromParent = () => controller.abort(parent.reason ?? "task_cancelled")
    if (parent.aborted) abortFromParent()
    else parent.addEventListener("abort", abortFromParent, { once: true })
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort("image_generation_timeout")
    }, timeoutMs)
    return {
        signal: controller.signal,
        didTimeout: () => timedOut,
        dispose: () => {
            clearTimeout(timer)
            parent.removeEventListener("abort", abortFromParent)
        },
    }
}

export class ImageGenerationService {
    constructor(
        private readonly options: ImageGenerationServiceOptions,
        private readonly activeRequestsByProfile = new Map<string, number>(),
    ) {}

    withProfileResolver(profileResolver: ImageGenerationServiceOptions["profileResolver"]): ImageGenerationService {
        return new ImageGenerationService({ ...this.options, profileResolver }, this.activeRequestsByProfile)
    }

    hasAvailableProfile(): boolean {
        return this.isFeatureEnabled() && this.options.profileResolver.hasAvailableProfile()
    }

    resolveProfile(selector?: string): ResolvedImageProfile {
        this.assertFeatureEnabled()
        return this.options.profileResolver.resolve(selector)
    }

    async generate(request: ImageGenerationRequest, context: ImageGenerationServiceContext): Promise<ImageGenerationResult> {
        this.assertFeatureEnabled()
        const resolved = this.options.profileResolver.resolve(request.profileId)
        this.assertRequestIdentity(request, resolved)
        const settings = resolved.profile.imageGeneration
        const taskBudgetUsd = taskBudgetSetting(settings?.taskBudgetUsd)
        const timeoutMs = positiveIntegerSetting(
            settings?.requestTimeoutMs,
            DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
            "request timeout",
            MAX_IMAGE_GENERATION_TIMEOUT_MS,
        )
        const maxConcurrentRequests = positiveIntegerSetting(
            settings?.maxConcurrentRequests,
            DEFAULT_MAX_CONCURRENT_IMAGE_REQUESTS,
            "concurrency limit",
            MAX_CONCURRENT_IMAGE_REQUESTS,
        )
        this.acquireConcurrency(resolved.profile.id, maxConcurrentRequests)
        const execution = createExecutionSignal(context.signal, timeoutMs)
        let budgetReserved = false
        let providerCompleted = false
        let resultCommitted = false

        try {
            const preflight = this.options.policy.validate({
                request,
                capabilities: resolved.model.capabilities ?? {},
                pricing: resolved.model.pricing,
                budget: taskBudgetUsd === undefined ? context.budget : { limitUsd: taskBudgetUsd, spentUsd: 0 },
            })
            if (taskBudgetUsd !== undefined) {
                if (preflight.estimatedCostUsd === undefined || !this.options.budgetLedger) {
                    throw invalidExecutionSetting("Image generation budget enforcement is unavailable for this task.")
                }
                await this.options.budgetLedger.reserve({
                    requestId: request.requestId,
                    providerId: request.providerId,
                    modelId: request.modelId,
                    estimatedCostUsd: preflight.estimatedCostUsd,
                    limitUsd: taskBudgetUsd,
                })
                budgetReserved = true
            }

            const adapter = this.options.adapterRegistry.create(resolved.adapterId, {
                profile: resolved.profile,
                modelId: request.modelId,
                ...(this.options.artifactResolver.resolveImage
                    ? {
                          resolveReference: async (artifactId, signal) => {
                              const resolvedArtifact = await this.options.artifactResolver.resolveImage?.(artifactId)
                              if (!resolvedArtifact) {
                                  throw new ImageGenerationError({
                                      code: "invalid_request",
                                      message: `Image artifact ${artifactId} could not be resolved.`,
                                      retryable: false,
                                  })
                              }
                              if (signal.aborted) {
                                  throw new ImageGenerationError({
                                      code: "cancelled",
                                      message: "Image generation was cancelled.",
                                      retryable: false,
                                  })
                              }
                              return { bytes: resolvedArtifact.bytes, mimeType: resolvedArtifact.artifact.mimeType }
                          },
                      }
                    : {}),
            })

            for await (const event of adapter.generate(request, { signal: execution.signal })) {
                if (event.requestId !== request.requestId) {
                    throw new ImageGenerationError({
                        code: "invalid_response",
                        message: "Image provider returned an event for a different request.",
                        retryable: false,
                    })
                }
                if (event.type === "preview") {
                    if (!this.options.previewStore) {
                        await Promise.resolve(
                            context.onProgress?.({ type: "preview", requestId: event.requestId, timestampMs: event.timestampMs }),
                        ).catch(() => undefined)
                        continue
                    }
                    for (const [index, output] of event.outputs.entries()) {
                        if (output.source.kind !== "base64") {
                            throw new ImageGenerationError({
                                code: "invalid_response",
                                message: "Image provider returned a partial preview without inline image data.",
                                retryable: false,
                            })
                        }
                        const preview = await this.options.previewStore.persistPreview(
                            event.requestId,
                            event.sequence + index,
                            output.source.data,
                        )
                        await Promise.resolve(
                            context.onProgress?.({
                                type: "preview",
                                requestId: event.requestId,
                                timestampMs: event.timestampMs,
                                preview,
                            }),
                        ).catch(() => undefined)
                    }
                    continue
                }
                if (event.type === "failed") throw new ImageGenerationError(event.error)
                if (event.type === "cancelled") {
                    if (execution.didTimeout()) throw this.timeoutError()
                    throw new ImageGenerationError({ code: "cancelled", message: event.reason, retryable: false })
                }
                if (event.type !== "completed") continue
                providerCompleted = true
                if (budgetReserved) await this.options.budgetLedger?.settle(request.requestId)

                const parentArtifactIds = [...new Set(request.references.map((reference) => reference.artifactId))]
                const artifacts = await this.options.artifactResolver.persistProviderOutputs(
                    event.outputs,
                    {
                        providerId: request.providerId,
                        modelId: request.modelId,
                        requestId: request.requestId,
                        ...(parentArtifactIds.length > 0 ? { parentArtifactIds } : {}),
                    },
                    execution.signal,
                )
                const totalOutputBytes = artifacts.reduce((total, artifact) => total + artifact.byteLength, 0)
                resultCommitted = true
                return {
                    requestId: request.requestId,
                    profileId: resolved.profile.id,
                    providerId: request.providerId,
                    modelId: request.modelId,
                    artifacts,
                    usage: {
                        ...event.usage,
                        imageCount: artifacts.length,
                        totalOutputBytes,
                        ...preflight,
                    },
                }
            }

            throw new ImageGenerationError({
                code: "invalid_response",
                message: "Image generation ended without a completed result.",
                retryable: false,
            })
        } catch (error) {
            if (!resultCommitted) {
                await this.options.previewStore?.clearRequest(request.requestId).catch(() => undefined)
            }
            if (budgetReserved && !providerCompleted) {
                await this.options.budgetLedger?.release(request.requestId).catch(() => undefined)
            }
            if (execution.didTimeout()) throw this.timeoutError()
            if (context.signal.aborted && !(error instanceof ImageGenerationError && error.code === "cancelled")) {
                throw new ImageGenerationError({
                    code: "cancelled",
                    message: "Image generation was cancelled.",
                    retryable: false,
                })
            }
            throw error
        } finally {
            execution.dispose()
            this.releaseConcurrency(resolved.profile.id)
        }
    }

    private isFeatureEnabled(): boolean {
        return this.options.isFeatureEnabled?.() ?? true
    }

    private assertFeatureEnabled(): void {
        if (this.isFeatureEnabled()) return
        throw new ImageGenerationError({
            code: "invalid_request",
            message: "Image generation is disabled in Feature Settings.",
            retryable: false,
        })
    }

    private acquireConcurrency(profileId: string, limit: number): void {
        const active = this.activeRequestsByProfile.get(profileId) ?? 0
        if (active >= limit) {
            throw new ImageGenerationError({
                code: "concurrency_limit_exceeded",
                message: "The image generation concurrency limit is already occupied.",
                retryable: true,
            })
        }
        this.activeRequestsByProfile.set(profileId, active + 1)
    }

    private releaseConcurrency(profileId: string): void {
        const active = this.activeRequestsByProfile.get(profileId) ?? 0
        if (active <= 1) this.activeRequestsByProfile.delete(profileId)
        else this.activeRequestsByProfile.set(profileId, active - 1)
    }

    private timeoutError(): ImageGenerationError {
        return new ImageGenerationError({
            code: "timeout",
            message: "Image generation exceeded the configured request timeout.",
            retryable: true,
        })
    }

    private assertRequestIdentity(request: ImageGenerationRequest, resolved: ResolvedImageProfile): void {
        if (
            request.profileId !== resolved.profile.id ||
            request.providerId !== resolved.profile.provider ||
            request.modelId !== resolved.model.id
        ) {
            throw new ImageGenerationError({
                code: "invalid_request",
                message: "Image generation request identity does not match the resolved profile and model.",
                retryable: false,
            })
        }
    }
}
