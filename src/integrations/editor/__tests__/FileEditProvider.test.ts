import { beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { FileEditProvider } from "../FileEditProvider"

class FileEditProviderHarness extends FileEditProvider {
	seed(absolutePath: string, originalContent: string, documentContent: string): void {
		this.absolutePath = absolutePath
		this.originalContent = originalContent
		this.documentContent = documentContent
	}

	save(): Promise<boolean> {
		return this.saveDocument()
	}
}

describe("FileEditProvider", () => {
	const applyTextDocumentEdit = vi.fn()

	beforeEach(() => {
		applyTextDocumentEdit.mockReset()
		vi.spyOn(HostProvider, "workspace", "get").mockReturnValue({ applyTextDocumentEdit } as never)
	})

	it("saves background edits through the HostBridge and adopts formatter output", async () => {
		applyTextDocumentEdit.mockResolvedValue({ saved: true, conflict: false, content: "formatted\n" })
		const provider = new FileEditProviderHarness()
		provider.seed("C:\\workspace\\file.ts", "before\n", "after\n")

		await expect(provider.save()).resolves.toBe(true)
		expect(applyTextDocumentEdit).toHaveBeenCalledWith({
			filePath: "C:\\workspace\\file.ts",
			expectedContent: "before\n",
			content: "after\n",
		})
		await expect(provider.getContent()).resolves.toBe("formatted\n")
	})

	it("refuses to overwrite a document changed after the edit started", async () => {
		applyTextDocumentEdit.mockResolvedValue({ saved: false, conflict: true, content: "user edit\n" })
		const provider = new FileEditProviderHarness()
		provider.seed("C:\\workspace\\file.ts", "before\n", "after\n")

		await expect(provider.save()).resolves.toBe(false)
	})
})
