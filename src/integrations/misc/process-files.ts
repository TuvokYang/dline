import * as path from "path"

export function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
        case ".png":
            return "image/png"
        case ".jpeg":
        case ".jpg":
            return "image/jpeg"
        case ".webp":
            return "image/webp"
        default:
            throw new Error(`Unsupported file type: ${ext}`)
    }
}
