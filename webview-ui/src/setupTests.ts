import "@testing-library/jest-dom"
import { afterAll, vi } from "vitest"
import { installIsolatedTestDirectories } from "../../src/test/isolated-test-directories"

const cleanupIsolatedTestDirectories = installIsolatedTestDirectories(`webview-${process.pid}`)

afterAll(() => {
    cleanupIsolatedTestDirectories()
})

// "Official" jest workaround for mocking window.matchMedia()
// https://jestjs.io/docs/manual-mocks#mocking-methods-which-are-not-implemented-in-jsdom

Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // Deprecated
        removeListener: vi.fn(), // Deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
})

class TestResizeObserver implements ResizeObserver {
    disconnect(): void {}
    observe(_target: Element, _options?: ResizeObserverOptions): void {}
    unobserve(_target: Element): void {}
}

globalThis.ResizeObserver ??= TestResizeObserver

// Mock VSCode API for webview tests
vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn(),
}))
