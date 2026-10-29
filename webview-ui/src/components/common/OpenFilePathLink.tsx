import { StringRequest } from "@shared/proto/dline/common"
import { FileServiceClient } from "@/services/grpc-client"

export function fileNameFromPath(filePath: string): string {
    return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

export function OpenFilePathLink({ filePath, label }: { filePath: string; label?: string }) {
    return (
        <button
            aria-label={`Open log file ${fileNameFromPath(filePath)}`}
            className="flex flex-wrap items-center gap-1.5 border-0 bg-transparent p-0 text-left cursor-pointer"
            onClick={() => {
                void FileServiceClient.openFile(StringRequest.create({ value: filePath })).catch((error: unknown) => {
                    console.error("Failed to open log file:", error)
                })
            }}
            title={`Click to open: ${filePath}`}
            type="button">
            {label && <span className="shrink-0">{label}</span>}
            <span className="text-vscode-textLink-foreground underline break-all">{fileNameFromPath(filePath)}</span>
        </button>
    )
}
