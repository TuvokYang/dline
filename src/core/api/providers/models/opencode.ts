/**
 * OpenCode model catalog.
 *
 * This file deliberately declares no model. Every fact about a model —
 * identifier, label, context and output limits, cache flag, reasoning levels,
 * input modalities, accepted protocols and prices — is published by
 * `GET https://opencode.ai/inference/v1/models` and read by
 * `model-registry/remote/vendors/opencode.ts`.
 *
 * A hand-written entry here is a claim about the gateway that only the gateway
 * can make. A wrong claim is worse than an absent one: the settings page reports
 * an absent limit as unknown, while a guessed limit silently misconfigures
 * compaction and a guessed cache flag or thinking control advertises a
 * capability the model may not have.
 *
 * The catalog is empty on purpose. It is filled from the listing at run time and
 * is not written to disk, so nothing in this build can be mistaken for the
 * vendor's own statement.
 */
import type { ModelInfo } from "@shared/api"

export const openCodeModels: Record<string, ModelInfo> = {}
