import { describe, expect, it, vi } from "vitest"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import type { TaskConfig } from "../../types/TaskConfig"
import { withConfiguredEditProvider } from "../configured-edit-provider"

function config(backgroundEditEnabled: boolean): TaskConfig {
	const visualProvider = { open: vi.fn() }
	return {
		services: {
			diffViewProvider: visualProvider,
			stateManager: {
				getGlobalSettingsKey: vi.fn().mockReturnValue(backgroundEditEnabled),
			},
		},
	} as unknown as TaskConfig
}

describe("withConfiguredEditProvider", () => {
	it("keeps the Controller-owned visual provider for foreground edits", () => {
		const original = config(false)

		expect(withConfiguredEditProvider(original)).toBe(original)
	})

	it("uses an invocation-local non-visual host provider for background edits", () => {
		const original = config(true)
		const configured = withConfiguredEditProvider(original)

		expect(configured).not.toBe(original)
		expect(configured.services.diffViewProvider).toBeInstanceOf(FileEditProvider)
		expect(original.services.diffViewProvider).not.toBeInstanceOf(FileEditProvider)
	})
})
