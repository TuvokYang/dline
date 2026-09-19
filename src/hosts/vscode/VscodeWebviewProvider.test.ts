import { afterEach, describe, expect, it, vi } from "vitest"
import { WebviewProvider } from "@/core/webview"
import { WebviewProviderRegistry } from "@/core/webview/WebviewProviderRegistry"
import { Logger } from "@/shared/services/Logger"
import { VscodeWebviewProvider } from "./VscodeWebviewProvider"

vi.mock("@/registry", () => ({
	ExtensionRegistryInfo: { views: { Sidebar: "dline.SidebarProvider" } },
}))

vi.mock(import("@core/controller/ui/subscribeToShowWebview"), async (importOriginal) => ({
	...(await importOriginal()),
	sendShowWebviewEvent: vi.fn(async () => undefined),
}))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		get: () => ({ extensionFsPath: "C:\\extension" }),
	},
}))

type Disposable = { dispose(): void }
type Listener<T> = (event: T) => void

function createEvent<T>() {
	const listeners = new Set<Listener<T>>()
	return {
		event(listener: Listener<T>, _thisArg?: unknown, disposables?: Disposable[]): Disposable {
			listeners.add(listener)
			const disposable = { dispose: () => listeners.delete(listener) }
			disposables?.push(disposable)
			return disposable
		},
		fire(event: T): void {
			for (const listener of [...listeners]) listener(event)
		},
		get size(): number {
			return listeners.size
		},
	}
}

function createWebviewView() {
	const dispose = createEvent<void>()
	const visibility = createEvent<void>()
	const messages = createEvent<unknown>()
	const postMessage = vi.fn(async () => true)
	const view = {
		visible: true,
		webview: {
			options: {},
			html: "",
			cspSource: "vscode-webview:",
			asWebviewUri: vi.fn((uri: { toString(): string }) => uri),
			onDidReceiveMessage: messages.event,
			postMessage,
		},
		onDidChangeVisibility: visibility.event,
		onDidDispose: dispose.event,
	}
	return { view, dispose, messages, postMessage }
}

function messageSender(provider: VscodeWebviewProvider) {
	return provider as unknown as {
		postMessageToWebview(message: unknown): Promise<boolean | undefined>
	}
}

function createProvider(): VscodeWebviewProvider {
	const provider = new VscodeWebviewProvider({ extensionMode: 1 } as never, { deferController: true })
	provider.attachController({
		setAccountUsagePollingEnabled: vi.fn(),
		postStateToWebview: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	} as never)
	vi.spyOn(provider, "getHtmlContent").mockReturnValue("<html></html>")
	return provider
}

describe("VscodeWebviewProvider registration", () => {
	afterEach(async () => {
		await WebviewProviderRegistry.disposeAll()
		vi.restoreAllMocks()
	})

	it("registers itself as the sidebar provider", () => {
		const provider = new VscodeWebviewProvider({} as never, { deferController: true })

		expect(WebviewProvider.getInstance()).toBe(provider)
	})

	it("logs a payload-free diagnostic when no active view can receive a message", async () => {
		const provider = createProvider()
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		const secret = "sk-live-should-never-be-logged"

		await messageSender(provider).postMessageToWebview({ type: "grpc_response", payload: secret })

		expect(warn).toHaveBeenCalledWith(
			"[VscodeWebviewProvider] Webview message delivery skipped",
			expect.objectContaining({ reason: "no_active_view", messageType: "grpc_response" }),
		)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
	})

	it("logs a payload-free diagnostic when VS Code rejects message delivery", async () => {
		const provider = createProvider()
		const webview = createWebviewView()
		webview.postMessage.mockResolvedValueOnce(false)
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		const secret = "ghp_should-never-be-logged"
		await provider.resolveWebviewView(webview.view as never)

		await messageSender(provider).postMessageToWebview({ type: "grpc_response", payload: secret })

		expect(warn).toHaveBeenCalledWith(
			"[VscodeWebviewProvider] Webview message delivery failed",
			expect.objectContaining({ reason: "post_message_rejected", messageType: "grpc_response" }),
		)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
	})

	it("keeps the newest view bound when an older view disposes late", async () => {
		const provider = createProvider()
		const first = createWebviewView()
		const second = createWebviewView()

		await provider.resolveWebviewView(first.view as never)
		await provider.resolveWebviewView(second.view as never)

		expect(first.messages.size).toBe(0)
		expect(second.messages.size).toBe(1)
		expect(provider.getWebview()).toBe(second.view)

		first.dispose.fire()

		expect(provider.getWebview()).toBe(second.view)
		expect(second.messages.size).toBe(1)
	})
})
