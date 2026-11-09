import { NewTaskRequest } from "@shared/proto/dline/task"
import React from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { UiText } from "@/i18n/UiText"
import { TaskServiceClient } from "@/services/grpc-client"
import QuickWinCard from "./QuickWinCard"
import { QuickWinTask, quickWinTasks } from "./quickWinTasks"

export const SuggestedTasks: React.FC<{ shouldShowQuickWins: boolean }> = ({ shouldShowQuickWins }) => {
    const { t } = useUiTranslation()

    const handleExecuteQuickWin = async (prompt: string) => {
        // `prompt` is model input and is forwarded unchanged.
        await TaskServiceClient.newTask(
            NewTaskRequest.create({
                text: prompt,
                images: [],
            }),
        )
    }

    if (shouldShowQuickWins) {
        return (
            <div className="px-4 pt-1 pb-3 select-none">
                {" "}
                <h2 className="text-sm font-medium mb-2.5 text-center text-gray">
                    <UiText
                        slots={{
                            accent: <span className="text-white">{t("shell.welcome.quickWins.accent")}</span>,
                        }}
                        text={t("shell.welcome.quickWins.heading")}
                    />
                </h2>
                <div className="flex flex-col space-y-1">
                    {" "}
                    {quickWinTasks.map((task: QuickWinTask) => (
                        <QuickWinCard key={task.id} onExecute={() => handleExecuteQuickWin(task.prompt)} task={task} />
                    ))}
                </div>
            </div>
        )
    }
}
