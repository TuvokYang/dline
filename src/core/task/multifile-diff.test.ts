import { showChangedFilesDiff } from "@core/task/multifile-diff"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi, expect as vitestExpect } from "vitest"
// sinon import removed: using vitest globals
import { HostProvider } from "@/hosts/host-provider"
import { ClineMessage } from "@/shared/ExtensionMessage"
import { ShowMessageType } from "@/shared/proto/dline/host"

describe("multifile-diff", () => {
	let messageStateHandlerStub: any /* sinon.SinonStub → vitest */
	let checkpointTrackerStub: any /* sinon.SinonStub → vitest */

	beforeEach(() => {
		vi.mocked(HostProvider.window.showMessage).mockClear()
		vi.mocked(HostProvider.diff.openMultiFileDiff).mockClear()

		// Create stubs for dependencies
		messageStateHandlerStub = { clineMessages: [] }
		checkpointTrackerStub = { getDiffSet: vi.fn(), getTaskDiffSet: vi.fn() }
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("showChangedFilesDiff", () => {
		const mockMessageTs = 1234567890
		const mockHash = "abc123def456"
		const mockMessages: ClineMessage[] = [
			{
				ts: mockMessageTs,
				type: "say",
				lastCheckpointHash: [mockHash],
				say: "text",
				text: "Test message",
			},
		]

		beforeEach(() => {
			Object.defineProperty(messageStateHandlerStub, "clineMessages", { configurable: true, get: () => mockMessages })
		})

		it("should successfully show diff for changes since last task completion", async () => {
			// Arrange
			const mockChangedFiles = [
				{
					relativePath: "src/file1.ts",
					absolutePath: "/project/src/file1.ts",
					before: "const a = 1;",
					after: "const a = 2;",
				},
				{
					relativePath: "src/file2.ts",
					absolutePath: "/project/src/file2.ts",
					before: "function test() {}",
					after: "function test() { return true; }",
				},
			]

			// Mock finding last completion message
			const messagesWithCompletion: ClineMessage[] = [
				{
					ts: 1234567000,
					type: "ask",
					ask: "completion_result",
					lastCheckpointHash: ["previous123"],
				},
				...mockMessages,
			]
			Object.defineProperty(messageStateHandlerStub, "clineMessages", {
				configurable: true,
				get: () => messagesWithCompletion,
			})

			checkpointTrackerStub.getTaskDiffSet.mockResolvedValue(mockChangedFiles)

			// Act
			await showChangedFilesDiff(
				messageStateHandlerStub as any,
				checkpointTrackerStub as any,
				mockMessageTs,
				true, // seeNewChangesSinceLastTaskCompletion
			)

			// Assert
			vitestExpect(checkpointTrackerStub.getTaskDiffSet).toHaveBeenCalledWith("previous123", mockHash)
			vitestExpect(HostProvider.diff.openMultiFileDiff).toHaveBeenCalledWith({
				title: "New changes",
				diffs: [
					{
						filePath: "/project/src/file1.ts",
						leftContent: "const a = 1;",
						rightContent: "const a = 2;",
					},
					{
						filePath: "/project/src/file2.ts",
						leftContent: "function test() {}",
						rightContent: "function test() { return true; }",
					},
				],
			})
		})

		it("should successfully show diff for changes since snapshot", async () => {
			// Arrange
			const mockChangedFiles = [
				{
					relativePath: "README.md",
					absolutePath: "/project/README.md",
					before: "# Project",
					after: "# My Project\n\nDescription added.",
				},
			]

			checkpointTrackerStub.getDiffSet.mockResolvedValue(mockChangedFiles)

			// Act
			await showChangedFilesDiff(
				messageStateHandlerStub as any,
				checkpointTrackerStub as any,
				mockMessageTs,
				false, // seeNewChangesSinceLastTaskCompletion
			)

			// Assert
			vitestExpect(checkpointTrackerStub.getDiffSet).toHaveBeenCalledWith(mockHash)
			vitestExpect(HostProvider.diff.openMultiFileDiff).toHaveBeenCalledWith({
				title: "Changes since snapshot",
				diffs: [
					{
						filePath: "/project/README.md",
						leftContent: "# Project",
						rightContent: "# My Project\n\nDescription added.",
					},
				],
			})
		})

		it("should handle message not found error", async () => {
			// Arrange
			Object.defineProperty(messageStateHandlerStub, "clineMessages", { configurable: true, get: () => [] })

			// Act
			await showChangedFilesDiff(messageStateHandlerStub as any, checkpointTrackerStub as any, mockMessageTs, false)

			// Assert
			expect(checkpointTrackerStub.getDiffSet.mock.calls.length > 0).to.be.false
			expect((HostProvider.diff.openMultiFileDiff as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0).to.be.false
		})

		it("should handle missing checkpoint hash", async () => {
			// Arrange
			const messagesWithoutHash: ClineMessage[] = [
				{
					ts: mockMessageTs,
					type: "say",
					say: "text",
					text: "Test message",
					// lastCheckpointHash is missing
				},
			]
			Object.defineProperty(messageStateHandlerStub, "clineMessages", {
				configurable: true,
				get: () => messagesWithoutHash,
			})

			// Act
			await showChangedFilesDiff(messageStateHandlerStub as any, checkpointTrackerStub as any, mockMessageTs, false)

			// Assert
			expect(checkpointTrackerStub.getDiffSet.mock.calls.length > 0).to.be.false
			expect((HostProvider.diff.openMultiFileDiff as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0).to.be.false
		})

		it("should show information message when no changes found", async () => {
			// Arrange
			checkpointTrackerStub.getDiffSet.mockResolvedValue([])

			// Act
			await showChangedFilesDiff(messageStateHandlerStub as any, checkpointTrackerStub as any, mockMessageTs, false)

			// Assert
			vitestExpect(HostProvider.window.showMessage).toHaveBeenCalledWith({
				type: ShowMessageType.INFORMATION,
				message: "No changes found",
			})
			expect((HostProvider.diff.openMultiFileDiff as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0).to.be.false
		})

		it("should handle getDiffSet errors gracefully", async () => {
			// Arrange
			const errorMessage = "Git operation failed"
			checkpointTrackerStub.getDiffSet.mockRejectedValue(new Error(errorMessage))

			// Act
			await showChangedFilesDiff(messageStateHandlerStub as any, checkpointTrackerStub as any, mockMessageTs, false)

			// Assert
			vitestExpect(HostProvider.window.showMessage).toHaveBeenCalledWith({
				type: ShowMessageType.ERROR,
				message: `Failed to retrieve diff set: ${errorMessage}`,
			})
			expect((HostProvider.diff.openMultiFileDiff as any) /* sinon.SinonStub → vitest */.mock.calls.length > 0).to.be.false
		})

		it("should use first checkpoint when no last completion found", async () => {
			// Arrange
			const messagesWithFirstCheckpoint: ClineMessage[] = [
				{
					ts: 1234567000,
					type: "say",
					say: "checkpoint_created",
					lastCheckpointHash: ["first123"],
				},
				...mockMessages,
			]
			Object.defineProperty(messageStateHandlerStub, "clineMessages", {
				configurable: true,
				get: () => messagesWithFirstCheckpoint,
			})

			checkpointTrackerStub.getTaskDiffSet.mockResolvedValue([
				{
					relativePath: "test.js",
					absolutePath: "/project/test.js",
					before: "",
					after: "console.log('test');",
				},
			])

			// Act
			await showChangedFilesDiff(
				messageStateHandlerStub as any,
				checkpointTrackerStub as any,
				mockMessageTs,
				true, // seeNewChangesSinceLastTaskCompletion
			)

			// Assert
			vitestExpect(checkpointTrackerStub.getTaskDiffSet).toHaveBeenCalledWith("first123", mockHash)
		})

		it("should show error when no previous checkpoint hash found for new changes", async () => {
			// Arrange
			// No completion_result or checkpoint_created messages
			Object.defineProperty(messageStateHandlerStub, "clineMessages", { configurable: true, get: () => mockMessages })

			// Act
			await showChangedFilesDiff(
				messageStateHandlerStub as any,
				checkpointTrackerStub as any,
				mockMessageTs,
				true, // seeNewChangesSinceLastTaskCompletion
			)

			// Assert
			vitestExpect(HostProvider.window.showMessage).toHaveBeenCalledWith({
				type: ShowMessageType.ERROR,
				message: "Unexpected error: No checkpoint hash found",
			})
			expect(checkpointTrackerStub.getDiffSet.mock.calls.length > 0).to.be.false
		})

		it("should handle large number of changed files", async () => {
			// Arrange
			const mockChangedFiles = Array.from({ length: 100 }, (_, i) => ({
				relativePath: `src/file${i}.ts`,
				absolutePath: `/project/src/file${i}.ts`,
				before: `// File ${i}`,
				after: `// Modified file ${i}`,
			}))

			checkpointTrackerStub.getDiffSet.mockResolvedValue(mockChangedFiles)

			// Act
			await showChangedFilesDiff(messageStateHandlerStub as any, checkpointTrackerStub as any, mockMessageTs, false)

			// Assert
			expect((HostProvider.diff.openMultiFileDiff as any) /* sinon.SinonStub → vitest */.mock.calls.length === 1).to.be.true
			const call = (HostProvider.diff.openMultiFileDiff as any) /* sinon.SinonStub → vitest */.mock.calls[0]
			expect(call[0].diffs).to.have.lengthOf(100)
		})
	})
})
