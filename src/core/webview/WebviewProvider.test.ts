import { describe, expect, it } from "vitest"
import { shouldLoadWebviewReactDevtools, shouldUseWebviewHmr } from "./WebviewProvider"

describe("shouldUseWebviewHmr", () => {
    it("uses HMR only for an explicit development host", () => {
        expect(shouldUseWebviewHmr(2, undefined)).toBe(true)
        expect(shouldUseWebviewHmr(1, undefined)).toBe(false)
        expect(shouldUseWebviewHmr(3, undefined)).toBe(false)
    })

    it("uses bundled assets in E2E even when the extension host is in development mode", () => {
        expect(shouldUseWebviewHmr(2, "true")).toBe(false)
        expect(shouldUseWebviewHmr(2, "1")).toBe(false)
    })

    it("allows a focused E2E diagnostic to exercise the development Webview", () => {
        expect(shouldUseWebviewHmr(2, "true", "true")).toBe(true)
        expect(shouldUseWebviewHmr(2, "true", "1")).toBe(true)
        expect(shouldUseWebviewHmr(1, "true", "true")).toBe(false)
    })
})

describe("shouldLoadWebviewReactDevtools", () => {
    it("does not load the standalone DevTools script by default", () => {
        expect(shouldLoadWebviewReactDevtools("true", undefined)).toBe(false)
        expect(shouldLoadWebviewReactDevtools("true", "false")).toBe(false)
    })

    it("loads the script only when both development mode and the explicit flag are enabled", () => {
        expect(shouldLoadWebviewReactDevtools("true", "true")).toBe(true)
        expect(shouldLoadWebviewReactDevtools("1", "1")).toBe(true)
        expect(shouldLoadWebviewReactDevtools(undefined, "true")).toBe(false)
    })
})
