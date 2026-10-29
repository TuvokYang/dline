import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { openingTrajectoryAccess } from "@core/trajectory/OpeningTrajectoryAccess"
import { TrajectoryAdmission } from "@core/trajectory/TrajectorySource"
import { TrajectoryState, type TrajectoryUpdate } from "@shared/proto/dline/task"
import { vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import {
    closeInstanceStoragesUnder,
    ensureInstanceLayout,
    hasOpenInstanceStoragesUnder,
    InstanceDatabase,
    instanceDatabaseExists,
    resolveInstanceLayout,
} from "../../../../storage/instance"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "../../../../storage/messages/openUiMessageRows"
import type { UiMessageRowStore } from "../../../../storage/messages/UiMessageRowStore"
import type { TaskOpening } from "../../opened-task"

// Longer than the maintainer's trailing debounce, as the production poll is.
export const LOCK_POLL_MS = 200

/** A task whose committed chat rows live in a private documents root, written through the real row store. */
export async function taskWithRows(taskId: string) {
    const documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-trajectory-rpc-"))
    vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
    const { root } = await ensureInstanceLayout({ taskId })
    let writer: UiMessageRowStore | undefined
    let nextTs = 1_000
    let ordinal = 0
    const append = async (...messages: Partial<UiMessage>[]) => {
        const records = messages.map((fields) => {
            nextTs += 10
            const message = { type: "say", ts: nextTs, ...fields } as UiMessage
            return { ordinal: ordinal++, ts: message.ts, message }
        })
        writer ??= await openUiMessageRows(root, UI_MESSAGE_WRITER)
        await writer.insert(records)
    }
    const closeWriter = async () => {
        await writer?.close()
        writer = undefined
    }
    return {
        root,
        append,
        prompt: (text: string) => ({ say: "task" as const, text }),
        reply: (text: string) => ({ say: "user_feedback" as const, text }),
        tool: () => ({ say: "tool" as const, text: JSON.stringify({ tool: "readFile", path: "a.ts" }) }),
        /** Whether `trajectory.db` was ever created for the task. */
        trajectoryExists: async () =>
            instanceDatabaseExists(await resolveInstanceLayout({ taskId }), InstanceDatabase.Trajectory),
        /** Whether `messages.db` exists; only the chat history's own writer may create it. */
        messagesExist: async () => instanceDatabaseExists(await resolveInstanceLayout({ taskId }), InstanceDatabase.Messages),
        /**
         * Whether the maintainer let go of the task: with the test's own message
         * writer closed, any storage still open under the root is the maintainer's
         * `trajectory.db` or its committed-message reader.
         */
        trajectoryReleased: async () => {
            await closeWriter()
            return !hasOpenInstanceStoragesUnder(root)
        },
        dispose: async () => {
            await closeWriter()
            await closeInstanceStoragesUnder(documentsRoot)
            vi.unstubAllEnvs()
            await rm(documentsRoot, { recursive: true, force: true })
        },
    }
}

/**
 * A Controller double exposing what the trajectory handlers use. Its access is
 * built the way `Controller.trajectoryAccess` builds it: current opening plus
 * the lock admission, and, for a history display, the ownerless lock check.
 */
export function trajectoryController(opening: TaskOpening, options: { historyDisplay?: boolean; ownerless?: boolean } = {}) {
    const admission = new TrajectoryAdmission()
    const state = { current: opening as TaskOpening | undefined, ownerless: options.ownerless ?? false }
    const controller = {
        currentOpening: () => state.current,
        trajectoryAccess: (owner: TaskOpening) =>
            openingTrajectoryAccess({
                taskId: owner.taskId,
                isCurrent: () => state.current === owner,
                admission,
                inspectOwnerless: options.historyDisplay ? async () => state.ownerless : undefined,
                pollMs: LOCK_POLL_MS,
            }),
    }
    return { controller, admission, state }
}

/** Responses of a stream folded the way the Webview folds them. */
export function trajectoryReceiver() {
    const updates: { update: TrajectoryUpdate; isLast: boolean }[] = []
    let prompts = new Map<number, string>()
    const responseStream = vi.fn(async (update: TrajectoryUpdate, isLast?: boolean) => {
        const previous = updates.at(-1)?.update
        if (!update.reset && previous && update.baseRevision !== previous.revision) {
            throw new Error(`delta based on ${update.baseRevision} after revision ${previous.revision}`)
        }
        if (update.reset) prompts = new Map()
        updates.push({ update, isLast: isLast === true })
        for (const turn of update.turns) prompts.set(turn.seq, turn.prompt)
        for (const seq of [...prompts.keys()]) if (seq >= update.turnCount) prompts.delete(seq)
    })
    return {
        updates,
        responseStream,
        last: () => updates.at(-1),
        prompts: () => [...prompts.entries()].sort(([a], [b]) => a - b).map(([, prompt]) => prompt),
        ready: () => updates.at(-1)?.update.state === TrajectoryState.TRAJECTORY_STATE_READY,
    }
}
