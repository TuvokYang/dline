import fs from "fs/promises"
import sizeOf from "image-size"
import { isBinaryFile } from "isbinaryfile"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import {
	ATTACHABLE_FILE_EXTENSIONS,
	ATTACHABLE_IMAGE_EXTENSIONS,
	formatAttachmentLimit,
	isTextAttachmentName,
	maxAttachmentBytes,
} from "@/shared/attachments"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"

function rejectAttachment(message: string): undefined {
	HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message })
	return undefined
}

function rejectNonTextAttachment(name: string): undefined {
	return rejectAttachment(`Not a text file: ${name} was skipped. Attach images, PDF, Word, Excel, or text files.`)
}

/**
 * Check that a non-image file on disk can be attached; reports the reason to the user when it cannot.
 * Returns the absolute path to attach, or undefined when the file is rejected.
 */
export async function validateAttachmentPath(filePath: string): Promise<string | undefined> {
	const name = path.basename(filePath)
	try {
		const stats = await fs.stat(filePath)
		if (!stats.isFile()) {
			return rejectAttachment(`Not a file: ${name} was skipped.`)
		}
		if (stats.size > maxAttachmentBytes(name)) {
			Logger.warn(`File too large, skipping: ${filePath}`)
			return rejectAttachment(`File too large: ${name} was skipped (size exceeds ${formatAttachmentLimit(name)}).`)
		}
		if (isTextAttachmentName(name) && (await isBinaryFile(filePath))) {
			return rejectNonTextAttachment(name)
		}
	} catch (error) {
		Logger.error(`Error checking attachment ${filePath}:`, error)
		return rejectAttachment(`Could not read ${name}, skipping.`)
	}
	return filePath
}

/**
 * Write a dropped or pasted file that has no host path (only bytes) into Dline's managed temp area,
 * so it can be attached like a picked file. Returns the staged path, or undefined when rejected.
 */
export async function stageAttachmentBytes(fileName: string, data: Uint8Array): Promise<string | undefined> {
	const name = path.basename(fileName)
	if (data.byteLength > maxAttachmentBytes(name)) {
		return rejectAttachment(`File too large: ${name} was skipped (size exceeds ${formatAttachmentLimit(name)}).`)
	}
	try {
		if (isTextAttachmentName(name) && (await isBinaryFile(Buffer.from(data.buffer, data.byteOffset, data.byteLength)))) {
			return rejectNonTextAttachment(name)
		}
		const stagedPath = await DlineRuntimeFileManager.createAttachmentPath(name)
		await fs.writeFile(stagedPath, data)
		return stagedPath
	} catch (error) {
		Logger.error(`Failed to stage attachment ${name}:`, error)
		return rejectAttachment(`Could not attach ${name}.`)
	}
}

/**
 * Supports processing of images and other file types
 * For models which don't support images, will not allow them to be selected
 */
export async function selectFiles(imagesAllowed: boolean): Promise<{ images: string[]; files: string[] }> {
	const IMAGE_EXTENSIONS = [...ATTACHABLE_IMAGE_EXTENSIONS]
	const OTHER_FILE_EXTENSIONS = [...ATTACHABLE_FILE_EXTENSIONS]

	const showDialogueResponse = await HostProvider.window.showOpenDialogue({
		canSelectMany: true,
		openLabel: "Select",
		filters: {
			files: imagesAllowed ? [...IMAGE_EXTENSIONS, ...OTHER_FILE_EXTENSIONS] : OTHER_FILE_EXTENSIONS,
		},
	})

	const filePaths = showDialogueResponse.paths

	if (!filePaths || filePaths.length === 0) {
		return { images: [], files: [] }
	}

	const processFilesPromises = filePaths.map(async (filePath: string) => {
		const fileExtension = path.extname(filePath).toLowerCase().substring(1)

		const isImage = IMAGE_EXTENSIONS.includes(fileExtension)

		if (isImage) {
			let buffer: Buffer
			try {
				// Read the file into a buffer first
				buffer = await fs.readFile(filePath)
				// Convert Node.js Buffer to Uint8Array
				const uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
				const dimensions = sizeOf(uint8Array) // Get dimensions from Uint8Array
				if (dimensions.width! > 7680 || dimensions.height! > 7680) {
					Logger.warn(`Image dimensions exceed 7500px, skipping: ${filePath}`)
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Image too large: ${path.basename(filePath)} was skipped (dimensions exceed 7500px).`,
					})
					return null
				}
			} catch (error) {
				Logger.error(`Error reading file or getting dimensions for ${filePath}:`, error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Could not read dimensions for ${path.basename(filePath)}, skipping.`,
				})
				return null
			}

			// If dimensions are valid, proceed to convert the existing buffer to base64
			const base64 = buffer.toString("base64")
			const mimeType = getMimeType(filePath)

			return { type: "image", data: `data:${mimeType};base64,${base64}` }
		}
		const attachablePath = await validateAttachmentPath(filePath)
		return attachablePath ? { type: "file", data: attachablePath } : null
	})

	const dataUrlsWithNulls = await Promise.all(processFilesPromises)
	const dataUrlsWithoutNulls = dataUrlsWithNulls.filter((item: any) => item !== null)

	const images: string[] = []
	const files: string[] = []

	for (const item of dataUrlsWithoutNulls) {
		if (item?.type === "image") {
			images.push(item?.data ?? "")
		} else {
			files.push(item?.data ?? "")
		}
	}

	return { images, files }
}

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
