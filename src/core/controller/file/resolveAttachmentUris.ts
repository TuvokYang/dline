import { validateAttachmentPath } from "@integrations/misc/process-files"
import { StringArray } from "@shared/proto/dline/common"
import { RelativePathsRequest } from "@shared/proto/dline/file"
import { URI } from "vscode-uri"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Resolves file URIs dropped or pasted into the composer to host paths that can be attached.
 * Files that are not attachable are omitted; the reason has already been shown to the user.
 */
export async function resolveAttachmentUris(_controller: Controller, request: RelativePathsRequest): Promise<StringArray> {
	const paths: string[] = []
	for (const uri of request.uris) {
		let filePath: string
		try {
			filePath = URI.parse(uri, true).fsPath
		} catch (error) {
			Logger.error(`Ignoring unparsable attachment URI ${uri}:`, error)
			continue
		}
		const attachablePath = await validateAttachmentPath(filePath)
		if (attachablePath) {
			paths.push(attachablePath)
		}
	}
	return StringArray.create({ values: paths })
}
