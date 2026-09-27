import type { ChokidarOptions, FSWatcher } from "chokidar"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fileContextKey, type WorkspaceFileChange, WorkspaceFileContextRegistry } from "../WorkspaceFileContextRegistry"

const CWD = path.resolve("/workspace")

interface FakeWatcher {
	readonly watcher: FSWatcher
	readonly close: ReturnType<typeof vi.fn>
	emitChange(): void
	emitError(error: Error): void
}

/** Minimal chokidar stand-in so tests observe watcher creation and closure directly. */
function createFakeWatchFactory() {
	const created: { path: string; fake: FakeWatcher }[] = []
	const watch = vi.fn((watchPath: string, _options: ChokidarOptions) => {
		const handlers = new Map<string, (payload?: unknown) => void>()
		const close = vi.fn(async () => {})
		const watcher = {
			on: (event: string, handler: (payload?: unknown) => void) => {
				handlers.set(event, handler)
				return watcher
			},
			close,
		} as unknown as FSWatcher
		created.push({
			path: watchPath,
			fake: {
				watcher,
				close,
				emitChange: () => handlers.get("change")?.(),
				emitError: (error: Error) => handlers.get("error")?.(error),
			},
		})
		return watcher
	})
	return { watch, created }
}

describe("WorkspaceFileContextRegistry", () => {
	let factory: ReturnType<typeof createFakeWatchFactory>
	let registry: WorkspaceFileContextRegistry

	beforeEach(() => {
		factory = createFakeWatchFactory()
		registry = new WorkspaceFileContextRegistry({ watch: factory.watch })
	})

	it("creates one watcher for repeated subscriptions to the same path", () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.subscribe(CWD, "./src/app.ts", vi.fn())

		expect(factory.watch).toHaveBeenCalledTimes(1)
		expect(factory.created[0].path).toBe(path.resolve(CWD, "src/app.ts"))
	})

	it("creates separate watchers for different paths", () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.subscribe(CWD, "src/other.ts", vi.fn())

		expect(factory.watch).toHaveBeenCalledTimes(2)
	})

	it("closes the watcher only after the last subscriber releases it", async () => {
		const first = registry.subscribe(CWD, "src/app.ts", vi.fn())
		const second = registry.subscribe(CWD, "src/app.ts", vi.fn())
		const { close } = factory.created[0].fake

		await first.dispose()
		expect(close).not.toHaveBeenCalled()

		await second.dispose()
		expect(close).toHaveBeenCalledTimes(1)
	})

	it("recreates a watcher after every subscriber released the path", async () => {
		const subscription = registry.subscribe(CWD, "src/app.ts", vi.fn())
		await subscription.dispose()
		registry.subscribe(CWD, "src/app.ts", vi.fn())

		expect(factory.watch).toHaveBeenCalledTimes(2)
	})

	it("ignores repeated disposal of the same subscription", async () => {
		const first = registry.subscribe(CWD, "src/app.ts", vi.fn())
		const second = registry.subscribe(CWD, "src/app.ts", vi.fn())
		const { close } = factory.created[0].fake

		await first.dispose()
		await first.dispose()
		expect(close).not.toHaveBeenCalled()

		await second.dispose()
		expect(close).toHaveBeenCalledTimes(1)
	})

	it("fans out an external change to every subscriber with one shared revision", () => {
		const first = vi.fn()
		const second = vi.fn()
		registry.subscribe(CWD, "src/app.ts", first)
		registry.subscribe(CWD, "src/app.ts", second)

		factory.created[0].fake.emitChange()

		expect(first).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
		expect(second).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: false })
		expect(registry.getRevision(CWD, "src/app.ts")).toBe(1)
	})

	it("nominates exactly one metadata author per change", () => {
		const first = vi.fn()
		const second = vi.fn()
		const third = vi.fn()
		registry.subscribe(CWD, "src/app.ts", first)
		registry.subscribe(CWD, "src/app.ts", second)
		registry.subscribe(CWD, "src/app.ts", third)

		factory.created[0].fake.emitChange()

		const authors = [first, second, third].filter((notify) =>
			notify.mock.calls.some(([change]) => (change as WorkspaceFileChange).isMetadataAuthor),
		)
		expect(authors).toHaveLength(1)
	})

	it("reports each subscriber's own requested path spelling", () => {
		const absolute = vi.fn()
		const relative = vi.fn()
		registry.subscribe(CWD, path.resolve(CWD, "src/app.ts"), absolute)
		registry.subscribe(CWD, "src/app.ts", relative)

		factory.created[0].fake.emitChange()

		expect(absolute).toHaveBeenCalledWith({
			filePath: path.resolve(CWD, "src/app.ts"),
			revision: 1,
			isMetadataAuthor: true,
		})
		expect(relative).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: false })
	})

	it("advances the revision on each observed change", () => {
		const notify = vi.fn()
		registry.subscribe(CWD, "src/app.ts", notify)

		factory.created[0].fake.emitChange()
		factory.created[0].fake.emitChange()

		expect(notify.mock.calls.map(([change]) => (change as WorkspaceFileChange).revision)).toEqual([1, 2])
	})

	it("keeps revisions monotonic across different paths", () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.subscribe(CWD, "src/other.ts", vi.fn())

		factory.created[0].fake.emitChange()
		factory.created[1].fake.emitChange()

		expect(registry.getRevision(CWD, "src/app.ts")).toBe(1)
		expect(registry.getRevision(CWD, "src/other.ts")).toBe(2)
	})

	it("absorbs changes while a Dline write is in progress and reports changes after it settles", () => {
		const notify = vi.fn()
		registry.subscribe(CWD, "src/app.ts", notify)
		registry.markSelfEdit(CWD, "src/app.ts")

		factory.created[0].fake.emitChange()
		factory.created[0].fake.emitChange()
		expect(notify).not.toHaveBeenCalled()
		expect(registry.getRevision(CWD, "src/app.ts")).toBe(0)

		registry.settleSelfEdit(CWD, "src/app.ts")
		factory.created[0].fake.emitChange()
		expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
	})

	it("swallows exactly one late change of an unfingerprinted Dline write", () => {
		const notify = vi.fn()
		registry.subscribe(CWD, "src/app.ts", notify)
		registry.markSelfEdit(CWD, "src/app.ts")
		registry.settleSelfEdit(CWD, "src/app.ts")

		factory.created[0].fake.emitChange()
		expect(notify).not.toHaveBeenCalled()

		factory.created[0].fake.emitChange()
		expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
	})

	describe("content fingerprints", () => {
		let content: string
		beforeEach(() => {
			content = "original"
			registry = new WorkspaceFileContextRegistry({ watch: factory.watch, fingerprint: () => content })
		})

		it("ignores a change event that leaves the content unchanged", () => {
			const notify = vi.fn()
			registry.subscribe(CWD, "src/app.ts", notify)

			factory.created[0].fake.emitChange()

			expect(notify).not.toHaveBeenCalled()
			expect(registry.getRevision(CWD, "src/app.ts")).toBe(0)
		})

		it("absorbs every change event while Dline is writing", () => {
			const notify = vi.fn()
			registry.subscribe(CWD, "src/app.ts", notify)
			registry.markSelfEdit(CWD, "src/app.ts")
			content = "partial write"
			factory.created[0].fake.emitChange()
			content = "final write"
			factory.created[0].fake.emitChange()
			registry.settleSelfEdit(CWD, "src/app.ts")

			expect(notify).not.toHaveBeenCalled()
			content = "edited by the user"
			factory.created[0].fake.emitChange()
			expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
		})

		it("does not report a Dline write whose change event arrives after the write settled", () => {
			const notify = vi.fn()
			registry.subscribe(CWD, "src/app.ts", notify)
			registry.markSelfEdit(CWD, "src/app.ts")
			content = "written by Dline"
			registry.settleSelfEdit(CWD, "src/app.ts")

			factory.created[0].fake.emitChange()
			expect(notify).not.toHaveBeenCalled()

			content = "edited by the user"
			factory.created[0].fake.emitChange()
			expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
		})
	})

	it("derives one key for relative and absolute spellings of a path", () => {
		expect(fileContextKey(CWD, "src/app.ts")).toBe(fileContextKey(CWD, path.resolve(CWD, "src/app.ts")))
		expect(fileContextKey(CWD, fileContextKey(CWD, "src/app.ts"))).toBe(fileContextKey(CWD, "src/app.ts"))
	})

	it.runIf(process.platform === "win32")("shares one watcher for path spellings that differ only in case on Windows", () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.subscribe(CWD, path.resolve(CWD, "SRC/App.ts"), vi.fn())

		expect(factory.watch).toHaveBeenCalledTimes(1)
	})

	it("ignores a self-edit marker for a path that has no watcher", () => {
		registry.markSelfEdit(CWD, "src/app.ts")

		const notify = vi.fn()
		registry.subscribe(CWD, "src/app.ts", notify)
		factory.created[0].fake.emitChange()

		expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
	})

	it("drops a self-edit marker once the last subscriber releases the path", async () => {
		const subscription = registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.markSelfEdit(CWD, "src/app.ts")
		await subscription.dispose()

		const notify = vi.fn()
		registry.subscribe(CWD, "src/app.ts", notify)
		factory.created[1].fake.emitChange()

		expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
	})

	it("hides a self-edit from every subscriber of the path", () => {
		const author = vi.fn()
		const observer = vi.fn()
		registry.subscribe(CWD, "src/app.ts", author)
		registry.subscribe(CWD, "src/app.ts", observer)
		registry.markSelfEdit(CWD, "src/app.ts")

		factory.created[0].fake.emitChange()

		expect(author).not.toHaveBeenCalled()
		expect(observer).not.toHaveBeenCalled()
	})

	it("keeps notifying remaining subscribers after one disposes", async () => {
		const leaving = vi.fn()
		const staying = vi.fn()
		const subscription = registry.subscribe(CWD, "src/app.ts", leaving)
		registry.subscribe(CWD, "src/app.ts", staying)

		await subscription.dispose()
		factory.created[0].fake.emitChange()

		expect(leaving).not.toHaveBeenCalled()
		expect(staying).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
	})

	it("keeps notifying other subscribers when one throws", () => {
		const failing = vi.fn(() => {
			throw new Error("subscriber failed")
		})
		const healthy = vi.fn()
		registry.subscribe(CWD, "src/app.ts", failing)
		registry.subscribe(CWD, "src/app.ts", healthy)

		expect(() => factory.created[0].fake.emitChange()).not.toThrow()
		expect(healthy).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 1, isMetadataAuthor: true })
	})

	it("does not throw when the watcher reports an error", () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())

		expect(() => factory.created[0].fake.emitError(new Error("watch failed"))).not.toThrow()
	})

	it("adopts a restored revision and keeps the counter above it", () => {
		const notify = vi.fn()
		registry.subscribe(CWD, "src/app.ts", notify)
		registry.adoptRevision(CWD, "src/app.ts", 7)

		expect(registry.getRevision(CWD, "src/app.ts")).toBe(7)

		factory.created[0].fake.emitChange()
		expect(notify).toHaveBeenCalledWith({ filePath: "src/app.ts", revision: 8, isMetadataAuthor: true })
	})

	it("never lowers a revision through adoption", () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		factory.created[0].fake.emitChange()
		factory.created[0].fake.emitChange()

		registry.adoptRevision(CWD, "src/app.ts", 1)

		expect(registry.getRevision(CWD, "src/app.ts")).toBe(2)
	})

	it("ignores non-positive and non-integer adopted revisions", () => {
		registry.adoptRevision(CWD, "src/app.ts", 0)
		registry.adoptRevision(CWD, "src/app.ts", -3)
		registry.adoptRevision(CWD, "src/app.ts", 1.5)

		expect(registry.getRevision(CWD, "src/app.ts")).toBe(0)
	})

	it("closes every watcher on disposeAll and clears recorded revisions", async () => {
		registry.subscribe(CWD, "src/app.ts", vi.fn())
		registry.subscribe(CWD, "src/other.ts", vi.fn())
		factory.created[0].fake.emitChange()

		await registry.disposeAll()

		expect(factory.created[0].fake.close).toHaveBeenCalledTimes(1)
		expect(factory.created[1].fake.close).toHaveBeenCalledTimes(1)
		expect(registry.getRevision(CWD, "src/app.ts")).toBe(0)
	})
})
