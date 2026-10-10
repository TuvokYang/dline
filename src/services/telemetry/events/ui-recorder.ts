import { Logger } from "@/shared/services/Logger"
import { TELEMETRY_EVENTS, TELEMETRY_METRICS } from "./catalog"
import { DomainRecorder } from "./domain-recorder"

/**
 * Threshold above which a gRPC response is worth warning about locally.
 *
 * Named because the number encodes a product judgement — 4 MB is where the
 * webview starts to stall — not an arbitrary limit.
 */
const LARGE_GRPC_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * UI interaction and focus-chain telemetry, plus transport size observability.
 *
 * Focus chain lives here rather than with task events because it is a view
 * feature: the events describe what the user did with the list, not what the
 * agent did with the task.
 */
export class UiEventRecorder extends DomainRecorder {
    /**
     * Records when a different model is selected for use
     * @param model Name of the selected model
     * @param provider Provider of the selected model
     * @param ulid Optional task identifier if model was selected during a task
     */
    captureModelSelected(model: string, provider: string, ulid?: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.UI.MODEL_SELECTED, { model, provider, ulid })
    }

    /**
     * Records when the user uses the model favorite button in the model picker
     * @param model The name of the model the user has interacted with
     * @param isFavorited Whether the model is being favorited (true) or unfavorited (false)
     */
    captureModelFavoritesUsage(model: string, isFavorited: boolean): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.UI.MODEL_FAVORITE_TOGGLED, { model, isFavorited })
    }

    captureButtonClick(button: string, ulid?: string): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.UI.BUTTON_CLICKED, { button, ulid })
    }

    /** Records when the rules menu button is clicked to open the rules/workflows modal */
    captureRulesMenuOpened(): void {
        this.sink.captureEvent(TELEMETRY_EVENTS.UI.RULES_MENU_OPENED, {})
    }

    /**
     * Records when focus chain is enabled/disabled by the user
     * @param enabled Whether focus chain was enabled (true) or disabled (false)
     */
    captureFocusChainToggle(enabled: boolean): void {
        if (!this.sink.isCategoryEnabled("focus_chain")) {
            return
        }

        this.sink.captureEvent(enabled ? TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_ENABLED : TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_DISABLED, {
            enabled,
        })
    }

    /**
     * Records when a task progress list is returned by the model for the first time in a task
     * @param ulid Unique identifier for the task
     * @param totalItems Number of items in the initial focus chain list
     */
    captureFocusChainProgressFirst(ulid: string, totalItems: number): void {
        if (!this.sink.isCategoryEnabled("focus_chain")) {
            return
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_PROGRESS_FIRST, { ulid, totalItems })
    }

    /**
     * Records when a task progress list is updated by the model mid-task
     * @param ulid Unique identifier for the task
     * @param totalItems Total number of items in the focus chain list
     * @param completedItems Number of completed items in the focus chain list
     */
    captureFocusChainProgressUpdate(ulid: string, totalItems: number, completedItems: number): void {
        if (!this.sink.isCategoryEnabled("focus_chain")) {
            return
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_PROGRESS_UPDATE, {
            ulid,
            totalItems,
            completedItems,
            completionPercentage: completionPercentage(totalItems, completedItems),
        })
    }

    /**
     * Records when a task ends but the task progress list is not complete
     * @param ulid Unique identifier for the task
     * @param totalItems Total number of items in the focus chain list
     * @param completedItems Number of completed items
     * @param incompleteItems Number of incomplete items
     * @param modelId The model ID being used
     * @param provider The API provider being used
     */
    captureFocusChainIncompleteOnCompletion(
        ulid: string,
        totalItems: number,
        completedItems: number,
        incompleteItems: number,
        modelId: string,
        provider: string,
    ): void {
        if (!this.sink.isCategoryEnabled("focus_chain")) {
            return
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_INCOMPLETE_ON_COMPLETION, {
            ulid,
            totalItems,
            completedItems,
            incompleteItems,
            completionPercentage: completionPercentage(totalItems, completedItems),
            modelId,
            provider,
        })
    }

    /**
     * Records when users click to open the focus chain markdown file
     * @param ulid Unique identifier for the task
     */
    captureFocusChainListOpened(ulid: string): void {
        if (!this.sink.isCategoryEnabled("focus_chain")) {
            return
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_LIST_OPENED, { ulid })
    }

    /**
     * Records when users save and write to the focus chain markdown file
     * @param ulid Unique identifier for the task
     */
    captureFocusChainListWritten(ulid: string): void {
        if (!this.sink.isCategoryEnabled("focus_chain")) {
            return
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FOCUS_CHAIN_LIST_WRITTEN, { ulid })
    }

    /**
     * Records the size of a gRPC response message for observability.
     *
     * @param sizeUtf8Bytes Size in UTF-8 bytes (use `Buffer.byteLength`, not `string.length`)
     * @param service The gRPC service name
     * @param method The gRPC method name
     * @param requestId Optional request ID for correlation
     */
    captureGrpcResponseSize(sizeUtf8Bytes: number, service: string, method: string, requestId?: string): void {
        this.sink.recordHistogram(
            TELEMETRY_METRICS.GRPC.RESPONSE_SIZE_BYTES,
            sizeUtf8Bytes,
            {
                service,
                method,
                ...(requestId && { request_id: requestId }),
            },
            "Size of gRPC response messages in bytes",
        )

        if (sizeUtf8Bytes > LARGE_GRPC_RESPONSE_BYTES) {
            Logger.warn(
                `[TelemetryService] Large gRPC response: ${service}.${method} ` +
                    `size=${(sizeUtf8Bytes / (1024 * 1024)).toFixed(1)}MB` +
                    (requestId ? ` request_id=${requestId}` : ""),
            )
        }
    }
}

/** Percent complete, guarding the empty-list case that would divide by zero. */
function completionPercentage(totalItems: number, completedItems: number): number {
    return totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0
}
