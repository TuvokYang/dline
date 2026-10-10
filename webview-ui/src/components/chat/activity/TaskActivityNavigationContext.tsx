import { createContext, type ReactNode, useContext } from "react"

type NavigateToTaskActivity = (activityId: string) => void

const TaskActivityNavigationContext = createContext<NavigateToTaskActivity>(() => undefined)

export function TaskActivityNavigationProvider({
    children,
    onNavigate,
}: {
    children: ReactNode
    onNavigate: NavigateToTaskActivity
}) {
    return <TaskActivityNavigationContext.Provider value={onNavigate}>{children}</TaskActivityNavigationContext.Provider>
}

export function useTaskActivityNavigation(): NavigateToTaskActivity {
    return useContext(TaskActivityNavigationContext)
}
