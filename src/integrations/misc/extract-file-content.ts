import { Anthropic } from "@anthropic-ai/sdk"
import fs from "fs/promises"
import * as path from "path"
import { extractImageContent } from "./extract-images"
import { callTextExtractionFunctions, requiresDocumentExtraction } from "./extract-text"

export type FileContentResult = {
    text: string
    imageBlock?: Anthropic.ImageBlockParam
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp"])

/** Whether the file is read by decoding its bytes as text, so it can be read line by line. */
export function isPlainTextFile(absolutePath: string): boolean {
    return !IMAGE_EXTENSIONS.has(path.extname(absolutePath).toLowerCase()) && !requiresDocumentExtraction(absolutePath)
}

/**
 * Extract content from a file, handling both text and images
 * Extra logic for handling images based on whether the model supports images
 */
export async function extractFileContent(absolutePath: string, modelSupportsImages: boolean): Promise<FileContentResult> {
    // Check if file exists first
    try {
        await fs.access(absolutePath)
    } catch (_error) {
        throw new Error(`File not found: ${absolutePath}`)
    }

    const isImage = IMAGE_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())

    if (isImage && modelSupportsImages) {
        const imageResult = await extractImageContent(absolutePath)

        if (imageResult.success) {
            return {
                text: "Successfully read image",
                imageBlock: imageResult.imageBlock,
            }
        }
        throw new Error(imageResult.error)
    }
    if (isImage && !modelSupportsImages) {
        throw new Error(`Current model does not support image input`)
    }
    // Handle text files using existing extraction functions
    try {
        const textContent = await callTextExtractionFunctions(absolutePath)
        return {
            text: textContent,
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        throw new Error(`Error reading file: ${errorMessage}`)
    }
}
