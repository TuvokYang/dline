import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { TaskActivity, TaskActivityEvent, TaskActivityUpdate } from "@shared/proto/dline/task"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useId, useMemo, useState } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import SubagentStatusRow from "./SubagentStatusRow"

/** Only the activity transport is mocked; the work card and all its scroll regions are real. */
function WorkCardFixture({ taskLines = 18 }: { taskLines?: number }) {
    const base = useExtensionState()
    const id = useId()
    const taskId = `subagent-work-layout-${id}`
    const [ready, setReady] = useState(false)
    const activity = useMemo(
        () =>
            TaskActivity.create({
                activityId: "layout-job",
                taskId,
                kind: "subagent",
                executionMode: "foreground",
                status: "completed",
                title: "reviewer",
                createdAt: 1,
                updatedAt: 2,
                finishedAt: 2,
                result: Array.from({ length: 30 }, (_, index) => `Output line ${index + 1}: verification evidence.`).join("\n\n"),
                events: Array.from({ length: 80 }, (_, index) =>
                    TaskActivityEvent.create({
                        sequence: index + 1,
                        timestamp: index + 1,
                        kind: "tool_call",
                        toolCallId: `read-${index}`,
                        toolName: "read_file",
                        toolStatus: "completed",
                        summary: `src/module-${index}.ts`,
                    }),
                ),
            }),
        [taskId],
    )
    useEffect(() => {
        const original = TaskServiceClient.subscribeToTaskActivities
        const subscribe: typeof original = (request, callbacks) => {
            if (request.taskId !== taskId) return original(request, callbacks)
            const timer = setTimeout(
                () =>
                    callbacks.onResponse(
                        TaskActivityUpdate.create({
                            taskId,
                            taskInstanceId: request.taskInstanceId,
                            sequence: 1,
                            snapshot: true,
                            activities: [activity],
                        }),
                    ),
                0,
            )
            return () => clearTimeout(timer)
        }
        TaskServiceClient.subscribeToTaskActivities = subscribe
        setReady(true)
        return () => {
            if (TaskServiceClient.subscribeToTaskActivities === subscribe) TaskServiceClient.subscribeToTaskActivities = original
        }
    }, [taskId, activity])
    const message: UiMessage = {
        ts: 1,
        type: "say",
        say: "subagent",
        text: JSON.stringify({
            status: "completed",
            items: [
                {
                    index: 1,
                    jobId: "layout-job",
                    subagentName: "reviewer",
                    prompt: "Review the modules",
                    task: Array.from(
                        { length: taskLines },
                        (_, index) => `Task line ${index + 1}: review the module and verify its behavior.`,
                    ).join("\n"),
                    context: "Keep all task, tool and output content accessible.",
                    status: "completed",
                    toolCalls: 80,
                    inputTokens: 0,
                    outputTokens: 0,
                    totalCost: 0,
                    currency: "USD",
                    contextTokens: 0,
                    contextWindow: 128_000,
                    contextUsagePercentage: 0,
                },
            ],
        }),
    }
    const taskViewState: TaskViewState = {
        taskId,
        taskInstanceId: "layout-opening",
        phase: "idle",
        stateRevision: 0,
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: { actions: [] },
    }
    return (
        <ExtensionStateContext.Provider value={{ ...base, taskViewState }}>
            <div className="w-full max-w-3xl" data-testid="subagent-work-fixture">
                {ready && <SubagentStatusRow isLast message={message} />}
            </div>
        </ExtensionStateContext.Provider>
    )
}

const meta = {
    title: "Chat/Subagent Work Card",
    component: WorkCardFixture,
    parameters: { layout: "padded" },
} satisfies Meta<typeof WorkCardFixture>
export default meta

type Story = StoryObj<typeof meta>
export const LongTaskAndTools: Story = { args: { taskLines: 18 } }
export const ShortTaskAndLongTools: Story = { args: { taskLines: 1 } }
