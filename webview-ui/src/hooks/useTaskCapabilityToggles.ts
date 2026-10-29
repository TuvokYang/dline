import {
    createTaskCapabilityToggles,
    serializeTaskCapabilityToggles,
    type TaskCapabilityToggleKey,
    type TaskCapabilityToggles,
} from "@shared/TaskCapabilityToggles"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { updateTaskSettings } from "@/components/settings/utils/settingsHandlers"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { taskCapabilityMutationCoordinator } from "./TaskCapabilityMutationCoordinator"

export function useTaskCapabilityToggles() {
    const {
        currentTaskItem,
        taskViewState,
        stateRevision,
        taskCapabilityToggles,
        setTaskCapabilityToggles,
        globalClineRulesToggles,
        localClineRulesToggles,
        localCursorRulesToggles,
        localWindsurfRulesToggles,
        localAgentsRulesToggles,
        globalWorkflowToggles,
        localWorkflowToggles,
        globalSkillsToggles,
        localSkillsToggles,
        remoteSkillsToggles,
        remoteRulesToggles,
        remoteWorkflowToggles,
        mcpServers,
    } = useExtensionState()
    const taskId = taskViewState?.taskId ?? currentTaskItem?.id
    const isTaskScoped = taskId !== undefined
    const inheritedSnapshot = useMemo(
        () =>
            createTaskCapabilityToggles({
                globalClineRulesToggles,
                localClineRulesToggles,
                localCursorRulesToggles,
                localWindsurfRulesToggles,
                localAgentsRulesToggles,
                globalWorkflowToggles,
                localWorkflowToggles,
                globalSkillsToggles,
                localSkillsToggles,
                remoteSkillsToggles,
                remoteRulesToggles,
                remoteWorkflowToggles,
                mcpServers: Object.fromEntries(mcpServers.map((server) => [server.name, server.disabled !== true])),
            }),
        [
            globalClineRulesToggles,
            localClineRulesToggles,
            localCursorRulesToggles,
            localWindsurfRulesToggles,
            localAgentsRulesToggles,
            globalWorkflowToggles,
            localWorkflowToggles,
            globalSkillsToggles,
            localSkillsToggles,
            remoteSkillsToggles,
            remoteRulesToggles,
            remoteWorkflowToggles,
            mcpServers,
        ],
    )
    const authoritativeSnapshot = isTaskScoped ? (taskCapabilityToggles ?? inheritedSnapshot) : undefined
    const authoritativeRevision = stateRevision ?? 0
    const currentTaskIdRef = useRef(taskId)
    currentTaskIdRef.current = taskId
    // The authoritative snapshot and revision change on every state publish, and
    // discovery polling publishes constantly. Reading them through refs keeps the
    // returned callbacks referentially stable, so consumers that list them as
    // effect dependencies do not tear down and restart their polling on each
    // publish. Callers still observe the latest values because the refs are read
    // when the callback runs, not when it is created.
    const authoritativeSnapshotRef = useRef(authoritativeSnapshot)
    authoritativeSnapshotRef.current = authoritativeSnapshot
    const authoritativeRevisionRef = useRef(authoritativeRevision)
    authoritativeRevisionRef.current = authoritativeRevision
    const [, setCoordinatorVersion] = useState(0)
    const snapshot =
        taskId && authoritativeSnapshot
            ? taskCapabilityMutationCoordinator.observe(taskId, authoritativeSnapshot, authoritativeRevision)
            : undefined

    useEffect(() => {
        if (!taskId || !authoritativeSnapshot) return
        taskCapabilityMutationCoordinator.observe(taskId, authoritativeSnapshot, authoritativeRevision)
        return taskCapabilityMutationCoordinator.subscribe(taskId, () => setCoordinatorVersion((version) => version + 1))
    }, [authoritativeRevision, authoritativeSnapshot, taskId])

    const publish = useCallback(
        (operationTaskId: string, next: TaskCapabilityToggles) => {
            if (currentTaskIdRef.current === operationTaskId) setTaskCapabilityToggles(next)
        },
        [setTaskCapabilityToggles],
    )
    const persist = useCallback(
        (operationTaskId: string, next: TaskCapabilityToggles) =>
            updateTaskSettings(operationTaskId, {
                taskCapabilityToggles: serializeTaskCapabilityToggles(next),
            }).then(() => undefined),
        [],
    )

    const updateToggle = useCallback(
        (key: TaskCapabilityToggleKey, resourceId: string, enabled: boolean) => {
            const operationTaskId = currentTaskIdRef.current
            const authoritative = authoritativeSnapshotRef.current
            if (!operationTaskId || !authoritative) return Promise.resolve()
            return taskCapabilityMutationCoordinator.updateToggle({
                taskId: operationTaskId,
                authoritative,
                authoritativeRevision: authoritativeRevisionRef.current,
                key,
                resourceId,
                enabled,
                persist: (next) => persist(operationTaskId, next),
                publish: (next) => publish(operationTaskId, next),
            })
        },
        [persist, publish],
    )

    const reconcile = useCallback(
        (discovered: Partial<TaskCapabilityToggles>) => {
            const operationTaskId = currentTaskIdRef.current
            const authoritative = authoritativeSnapshotRef.current
            if (!operationTaskId || !authoritative) return Promise.resolve()
            return taskCapabilityMutationCoordinator.reconcile({
                taskId: operationTaskId,
                authoritative,
                authoritativeRevision: authoritativeRevisionRef.current,
                discovered,
                persist: (next) => persist(operationTaskId, next),
                publish: (next) => publish(operationTaskId, next),
            })
        },
        [persist, publish],
    )

    return { isTaskScoped, snapshot, updateToggle, reconcile }
}
