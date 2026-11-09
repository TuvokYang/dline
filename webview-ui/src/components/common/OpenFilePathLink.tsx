import { StringRequest } from "@shared/proto/dline/common"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { FileServiceClient } from "@/services/grpc-client"

export function fileNameFromPath(filePath: string): string {
    return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

export function OpenFilePathLink({ filePath, label }: { filePath: string; label?: string }) {
    const { t } = useUiTranslation()
    const fileName = fileNameFromPath(filePath)

    return (
        <button
            aria-label={t("shell.openFileLink.aria", { name: fileName })}
            className="flex flex-wrap items-center gap-1.5 border-0 bg-transparent p-0 text-left cursor-pointer"
            onClick={() => {
                void FileServiceClient.openFile(StringRequest.create({ value: filePath })).catch((error: unknown) => {
                    console.error("Failed to open log file:", error)
                })
            }}
            title={t("shell.openFileLink.title", { path: filePath })}
            type="button">
            {label && <span className="shrink-0">{label}</span>}
            <span className="text-vscode-textLink-foreground underline break-all">{fileName}</span>
        </button>
    )
}
