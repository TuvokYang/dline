import { isInteractionCancellationError } from "@core/task/interaction/InteractionCancellationError"

export interface TaskStartLifecycleOptions {
    taskId: string
    startInBackground: boolean
    beforeStart?: (taskId: string) => Promise<void> | void
    start: () => Promise<void>
    onBackgroundError: (error: unknown) => Promise<void> | void
}

/**
 * Admits a task start after its identity-dependent setup has completed.
 * Foreground starts preserve the existing await semantics. Background starts
 * return after admission while retaining an observed rejection path.
 */
async function reportBackgroundError(options: TaskStartLifecycleOptions, error: unknown): Promise<void> {
    if (isInteractionCancellationError(error)) return
    await options.onBackgroundError(error)
}

export async function startTaskLifecycle(options: TaskStartLifecycleOptions): Promise<void> {
    await options.beforeStart?.(options.taskId)

    if (!options.startInBackground) {
        await options.start()
        return
    }

    let startPromise: Promise<void>
    try {
        startPromise = options.start()
    } catch (error) {
        await reportBackgroundError(options, error)
        return
    }

    void startPromise.catch((error: unknown) => {
        void reportBackgroundError(options, error).catch(() => undefined)
    })
}
