import { TrajectorySource, type TrajectoryStream, taskTrajectoryMaintainers } from "@core/trajectory/TrajectorySource"
import type { TrajectoryRequest, TrajectoryUpdate } from "@shared/proto/dline/task"
import { trajectoryFrameToProto, UNAVAILABLE_TRAJECTORY_FRAME } from "@shared/proto-conversions/trajectory"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import { currentOpening } from "./opened-task"

/**
 * Stream the trajectory of the visible task opening.
 *
 * The first response is always a full reset; later ones are based on the
 * previous response's revision. The stream ends, with a final unavailable
 * reset keyed to the opening, when the opening is no longer current, the
 * client cancels, or the source fails; a Webview that sees it end resubscribes
 * with backoff.
 */
export async function subscribeToTrajectory(
    controller: Controller,
    request: TrajectoryRequest,
    responseStream: StreamingResponseHandler<TrajectoryUpdate>,
    requestId?: string,
): Promise<void> {
    const opening = { taskId: request.taskId, taskInstanceId: request.taskInstanceId }
    const ended = () => trajectoryFrameToProto(UNAVAILABLE_TRAJECTORY_FRAME, opening)
    const owner = currentOpening(controller, request)
    if (!owner) {
        await responseStream(ended(), true)
        return
    }

    const access = controller.trajectoryAccess(owner)
    const requestRegistry = getRequestRegistry()
    let completed = false
    let stream: TrajectoryStream | undefined
    let stopWatching: () => void = () => undefined
    // Never awaited from inside a frame delivery: closing the stream waits for that delivery.
    const complete = async () => {
        if (completed) return
        completed = true
        stopWatching()
        await stream?.close()
        try {
            await responseStream(ended(), true)
        } catch (error) {
            Logger.warn(`[trajectory] TrajectoryStreamEndFailed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            if (requestId) requestRegistry.cancelRequest(requestId)
        }
    }
    const isStale = () => controller.currentOpening() !== owner
    // Registered before any await, so a cancel that arrives while the source opens still ends it.
    stopWatching = access.onDidChange(() => {
        if (isStale()) void complete()
    })
    if (requestId) {
        requestRegistry.registerRequest(
            requestId,
            () => {
                completed = true
                stopWatching()
                void stream?.close()
            },
            { type: "trajectory_subscription", taskId: request.taskId },
            responseStream,
        )
    }

    try {
        await access.refresh()
        const maintainers = await taskTrajectoryMaintainers(owner.taskId)
        if (completed) return
        if (isStale()) {
            await complete()
            return
        }
        stream = new TrajectorySource(access, maintainers).subscribe(
            async (frame) => {
                if (completed) return
                if (isStale()) {
                    void complete()
                    return
                }
                try {
                    await responseStream(trajectoryFrameToProto(frame, owner), false)
                } catch (error) {
                    void complete()
                    throw error
                }
            },
            () => void complete(),
        )
    } catch (error) {
        Logger.warn(`[trajectory] TrajectorySubscriptionFailed: ${error instanceof Error ? error.message : String(error)}`)
        await complete()
    }
}
