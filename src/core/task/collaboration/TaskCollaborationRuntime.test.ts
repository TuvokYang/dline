import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../kernel"
import { INTAKE_BOX_LIMIT } from "../kernel/machines/intake"
import { InMemoryTaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { CoTaskMessageEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { type TaskCollaborationLease, TaskCollaborationRuntime } from "./TaskCollaborationRuntime"
import type { TaskIncarnationId } from "./TaskDirectory"

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
}

function appendCoTask(state: TaskState, entryId: string, payloadRef: string): TaskState {
    return {
        ...state,
        revision: state.revision + 1,
        intake: {
            ...state.intake,
            coTask: [
                ...state.intake.coTask,
                {
                    entryId: entryId as never,
                    payloadRef,
                    source: "cotask",
                    mode: "queued",
                    sequence: state.intake.coTask.length + 1,
                    state: "accepted",
                },
            ],
        },
    }
}

function register(
    runtime: TaskCollaborationRuntime,
    taskId: string,
    incarnation: string,
    options?: { readonly durable?: Promise<void> },
) {
    const state = { value: createInitialTaskState(taskId as never) }
    const payloads = new InMemoryTaskPayloadStore()
    const publish = vi.fn(async (entry: { entryId: string; payloadRef: string }) => {
        state.value = appendCoTask(state.value, entry.entryId, entry.payloadRef)
        return { kind: "accepted" as const, durable: options?.durable ?? Promise.resolve() }
    })
    const lease = runtime.register({
        taskId,
        taskIncarnationId: incarnation,
        createdAt: "2026-10-03T13:00:00.000Z",
        kind: "main",
        summary: taskId,
        state: () => state.value,
        ingress: { publish } as never,
        payloads,
    })
    return { state, payloads, publish, lease }
}

async function authorize(
    runtime: TaskCollaborationRuntime,
    source: TaskCollaborationLease,
    targetTaskId: string,
    id: string,
    dedupeKey = id,
) {
    const result = await runtime.authorizeDelivery({
        deliveryId: id,
        fromTaskId: source.descriptor.taskId,
        fromTaskIncarnationId: source.descriptor.taskIncarnationId,
        toTaskId: targetTaskId,
        dedupeKey,
        text: `message:${id}`,
    })
    if (result.kind !== "authorized") throw new Error(`Authorization failed: ${result.kind}`)
    return result.intent
}

describe("TaskCollaborationRuntime", () => {
    it("authorizes, copies and durably admits a least-authority CoTask payload", async () => {
        const runtime = new TaskCollaborationRuntime()
        const source = register(runtime, "source", "source-inc")
        const target = register(runtime, "target", "target-inc")
        const intent = await authorize(runtime, source.lease, "target", "delivery-1", "same-message")

        const admitted = await runtime.deliver(intent)
        expect(admitted).toMatchObject({ kind: "admitted", entryId: "cotask:delivery-1" })
        if (admitted.kind !== "admitted") throw new Error("Delivery was not admitted")
        const envelope = decodeTaskPayload<CoTaskMessageEnvelope>(await target.payloads.read(admitted.payloadRef))
        expect(envelope).toEqual({
            kind: "cotask_message",
            text: "message:delivery-1",
            source: {
                taskId: "source",
                taskIncarnationId: "source-inc",
                principalId: "task:source:source-inc",
                deliveryId: "delivery-1",
            },
        })
        expect(target.publish).toHaveBeenCalledOnce()
        expect(await runtime.deliver(intent)).toMatchObject({ kind: "duplicate", entryId: "cotask:delivery-1" })
        expect(target.publish).toHaveBeenCalledOnce()

        const conflicting = await authorize(runtime, source.lease, "target", "delivery-2", "same-message")
        expect(await runtime.deliver(conflicting)).toEqual({ kind: "not_admitted", reason: "dedupe_conflict" })
        expect(target.publish).toHaveBeenCalledOnce()

        target.state.value = {
            ...target.state.value,
            intake: {
                ...target.state.value.intake,
                coTask: Array.from({ length: INTAKE_BOX_LIMIT }, (_, index) => ({
                    entryId: `capacity-${index}` as never,
                    payloadRef: intent.payloadRef,
                    source: "cotask" as const,
                    mode: "queued" as const,
                    sequence: index + 1,
                    state: "accepted" as const,
                })),
            },
        }
        const capacityIntent = await authorize(runtime, source.lease, "target", "delivery-3")
        expect(await runtime.deliver(capacityIntent)).toEqual({
            kind: "target_capacity_exceeded",
            pending: INTAKE_BOX_LIMIT,
            limit: INTAKE_BOX_LIMIT,
        })

        await Promise.all([source.lease.release(), target.lease.release()])
    })

    it("holds source and target stores open until durable target admission settles", async () => {
        const durable = deferred()
        const runtime = new TaskCollaborationRuntime()
        const source = register(runtime, "source", "source-inc")
        const target = register(runtime, "target", "target-inc", { durable: durable.promise })
        const intent = await authorize(runtime, source.lease, "target", "delivery-lease")
        const delivery = runtime.deliver(intent)
        await vi.waitFor(() => expect(target.publish).toHaveBeenCalledOnce())

        let sourceReleased = false
        let targetReleased = false
        const sourceRelease = source.lease.release().then(() => (sourceReleased = true))
        const targetRelease = target.lease.release().then(() => (targetReleased = true))
        await Promise.resolve()
        expect(sourceReleased).toBe(false)
        expect(targetReleased).toBe(false)

        durable.resolve()
        expect(await delivery).toMatchObject({ kind: "admitted" })
        await Promise.all([sourceRelease, targetRelease])
        expect(sourceReleased).toBe(true)
        expect(targetReleased).toBe(true)
    })

    it("fences authorization and delivery to the exact live incarnations", async () => {
        const runtime = new TaskCollaborationRuntime()
        const source = register(runtime, "source", "source-inc")
        const firstTarget = register(runtime, "target", "target-inc-1")
        const intent = await authorize(runtime, source.lease, "target", "delivery-stale")
        await firstTarget.lease.release()
        const secondTarget = register(runtime, "target", "target-inc-2")

        expect(await runtime.deliver(intent)).toEqual({ kind: "stale" })
        expect(secondTarget.publish).not.toHaveBeenCalled()
        expect(
            await runtime.authorizeDelivery({
                deliveryId: "delivery-source-stale",
                fromTaskId: "source",
                fromTaskIncarnationId: "wrong-inc" as TaskIncarnationId,
                toTaskId: "target",
                dedupeKey: "stale",
                text: "stale",
            }),
        ).toEqual({ kind: "stale" })

        await Promise.all([source.lease.release(), secondTarget.lease.release()])
    })
})
