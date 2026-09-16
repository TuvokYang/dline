import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Locator, type Page } from "@playwright/test"
import { E2ETestHelper, e2e } from "../../utils/helpers"
import { resizePrimarySidebar } from "../../utils/resize-primary-sidebar"

export const DEMO_VIEWPORT = { width: 1_920, height: 1_080 } as const
export const DEMO_VIDEO_SIZE = DEMO_VIEWPORT
export const DEMO_SIDEBAR_WIDTH = 720
export const DEMO_ASSET_DIR = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "assets", "docs", "marketplace")
const DEMO_MANIFEST_DIR = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "tmp", "demo-media")
const DEFAULT_PACE_MS = 2_000
const SCREENCAST_QUALITY = 95

interface DemoCropRect {
	x: number
	y: number
	width: number
	height: number
}

type DemoCrop = "full" | "sidebar" | DemoCropRect

interface RegisterRecordingOptions {
	crop?: DemoCrop
	fps?: number
	outputWidth?: number
}

interface RecordingRegistration {
	id: string
	sourceWebm: string
	startedAtMs: number
	endedAtMs?: number
	crop?: DemoCropRect
	fps: number
	outputWidth: number
}

interface DemoRecordingState {
	registration?: RecordingRegistration
}

interface DemoFixtures {
	_demoRecordingState: DemoRecordingState
	_demoLayout: void
	pace: (milliseconds?: number) => Promise<void>
	registerRecording: (id: string, options?: RegisterRecordingOptions) => Promise<void>
	finishRecording: () => Promise<void>
	captureScreenshot: (id: string, target?: Locator) => Promise<string>
}

function assertAssetId(id: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new Error(`Invalid demo asset id: ${id}`)
	}
}

async function resolveCrop(page: Page, crop: DemoCrop): Promise<DemoCropRect | undefined> {
	if (crop === "full") return undefined
	if (crop !== "sidebar") return crop

	const primarySidebar = page.locator('[id="workbench.parts.sidebar"]')
	const box = await primarySidebar.boundingBox()
	if (!box) throw new Error("Cannot resolve the primary sidebar crop without a bounding box")

	return {
		x: 0,
		y: 0,
		width: Math.ceil(box.x + box.width),
		height: DEMO_VIEWPORT.height,
	}
}

async function configureScreencastSurface(page: Page): Promise<void> {
	const session = await page.context().newCDPSession(page)
	try {
		await session.send("Emulation.setDeviceMetricsOverride", {
			width: DEMO_VIDEO_SIZE.width,
			height: DEMO_VIDEO_SIZE.height,
			deviceScaleFactor: 1,
			mobile: false,
			screenWidth: DEMO_VIDEO_SIZE.width,
			screenHeight: DEMO_VIDEO_SIZE.height,
			dontSetVisibleSize: false,
		})
		await session.send("Emulation.setVisibleSize", DEMO_VIDEO_SIZE)
	} finally {
		await session.detach()
	}
}

async function dismissVSCodeNotifications(page: Page): Promise<void> {
	const visibleNotifications = page.locator(".notifications-toasts.visible .notification-toast")
	let consecutiveQuietChecks = 0

	for (let attempt = 0; attempt < 8; attempt += 1) {
		if ((await visibleNotifications.count()) === 0) {
			consecutiveQuietChecks += 1
			if (consecutiveQuietChecks === 2) return
			await page.waitForTimeout(250)
			continue
		}

		consecutiveQuietChecks = 0
		await E2ETestHelper.runCommandPalette(page, "Notifications: Clear All Notifications")
		await expect(visibleNotifications).toHaveCount(0)
		await page.waitForTimeout(250)
	}

	await expect(visibleNotifications).toHaveCount(0)
}

export const demo = e2e.extend<DemoFixtures>({
	_demoRecordingState: async ({}, use) => {
		await use({})
	},
	app: async ({ openVSCode, workspaceType, workspaceDir, multiRootWorkspaceDir, _demoRecordingState }, use, testInfo) => {
		const workspacePath = workspaceType === "single" ? workspaceDir : multiRootWorkspaceDir
		const app = await openVSCode(workspacePath, undefined, {
			windowSize: DEMO_VIEWPORT,
			forceDeviceScaleFactor: 1,
		})
		const page = await app.firstWindow()
		await app.evaluate(({ BrowserWindow }, size) => {
			const window = BrowserWindow.getAllWindows()[0]
			if (!window) throw new Error("VS Code BrowserWindow was not created")
			window.setFullScreen(false)
			window.unmaximize()
			window.setResizable(true)
			window.setContentSize(size.width, size.height)
			window.setPosition(0, 0)
		}, DEMO_VIEWPORT)
		await expect
			.poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })), {
				timeout: 10_000,
			})
			.toEqual(DEMO_VIEWPORT)
		try {
			await use(app)
		} finally {
			const registration = _demoRecordingState.registration
			try {
				if (registration && !registration.endedAtMs && !page.isClosed()) {
					const endedAtMs = Date.now()
					await page.screencast.stop()
					registration.endedAtMs = endedAtMs
				}
			} finally {
				await app.close()
			}

			if (registration) {
				const endedAtMs = registration.endedAtMs ?? Date.now()
				const sceneDurationSeconds = Math.max(0.25, (endedAtMs - registration.startedAtMs) / 1_000)
				const manifest = {
					schemaVersion: 1,
					id: registration.id,
					sourceWebm: registration.sourceWebm,
					viewport: DEMO_VIEWPORT,
					videoSize: DEMO_VIDEO_SIZE,
					outputFile: `${registration.id}.gif`,
					fps: registration.fps,
					outputWidth: registration.outputWidth,
					crop: registration.crop,
					trim: {
						durationSeconds: sceneDurationSeconds,
					},
				}
				await mkdir(DEMO_MANIFEST_DIR, { recursive: true })
				await writeFile(
					path.join(DEMO_MANIFEST_DIR, `${registration.id}.json`),
					`${JSON.stringify(manifest, null, 2)}\n`,
					"utf8",
				)
			}
		}
	},
	_demoLayout: [
		async ({ page, sidebar }, use) => {
			void sidebar
			await page.setViewportSize(DEMO_VIEWPORT)
			expect(page.viewportSize()).toEqual(DEMO_VIEWPORT)
			await expect
				.poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
				.toEqual(DEMO_VIEWPORT)
			const bottomPanel = page.locator('[id="workbench.parts.panel"]')
			if (await bottomPanel.isVisible()) await page.keyboard.press("ControlOrMeta+j")
			await expect(bottomPanel).toBeHidden()
			await resizePrimarySidebar(page, DEMO_SIDEBAR_WIDTH)
			await use()
		},
		{ auto: true },
	],
	pace: async ({ page }, use) => {
		await use((milliseconds = DEFAULT_PACE_MS) => page.waitForTimeout(milliseconds))
	},
	registerRecording: async ({ page, _demoRecordingState }, use, testInfo) => {
		await use(async (id, options = {}) => {
			assertAssetId(id)
			await dismissVSCodeNotifications(page)
			await configureScreencastSurface(page)
			if (_demoRecordingState.registration) {
				throw new Error(`Demo recording already registered as ${_demoRecordingState.registration.id}`)
			}
			const crop = options.crop ?? "full"
			const recordingDir = E2ETestHelper.getResultsDir(
				testInfo.title,
				"recordings",
				`${testInfo.testId}-retry-${testInfo.retry}`,
			)
			await mkdir(recordingDir, { recursive: true })
			const sourceWebm = path.join(recordingDir, `${id}.webm`)
			await page.screencast.start({ path: sourceWebm, size: DEMO_VIDEO_SIZE, quality: SCREENCAST_QUALITY })
			try {
				await page.screencast.showActions({ cursor: "pointer", duration: 500, fontSize: 1 })
			} catch (error) {
				await page.screencast.stop().catch(() => undefined)
				throw error
			}
			_demoRecordingState.registration = {
				id,
				sourceWebm,
				startedAtMs: Date.now(),
				crop: await resolveCrop(page, crop),
				fps: options.fps ?? 10,
				outputWidth: options.outputWidth ?? (crop === "sidebar" ? 600 : 1_200),
			}
		})
	},
	finishRecording: async ({ page, _demoRecordingState }, use) => {
		await use(async () => {
			const registration = _demoRecordingState.registration
			if (!registration) throw new Error("Cannot finish a demo recording before registering it")
			if (registration.endedAtMs) return
			const endedAtMs = Date.now()
			await page.screencast.stop()
			registration.endedAtMs = endedAtMs
		})
	},
	captureScreenshot: async ({ page }, use) => {
		await use(async (id, target) => {
			assertAssetId(id)
			await mkdir(DEMO_ASSET_DIR, { recursive: true })
			const screenshotPath = path.join(DEMO_ASSET_DIR, `${id}.png`)
			if (target) {
				await target.screenshot({ path: screenshotPath, animations: "disabled" })
			} else {
				await page.screenshot({ path: screenshotPath, animations: "disabled", fullPage: false })
			}
			return screenshotPath
		})
	},
})
