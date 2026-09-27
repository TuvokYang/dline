import { describe, expect, it } from "vitest"
import { buildClaudeCodeFingerprintHeaders, stainlessArch, stainlessOs } from "../client-headers"

/**
 * A genuine Claude Code CLI reports the machine it runs on, in the spelling the
 * Anthropic SDK normalises to. A fixed Linux/arm64 claim from a Windows x64
 * host, or the raw `win32` value, would each be a signature no real client
 * sends.
 */
describe("Claude Code fingerprint headers", () => {
	it("reports the host platform in Stainless spelling", () => {
		const headers = buildClaudeCodeFingerprintHeaders({ platform: "win32", arch: "x64", nodeVersion: "v22.19.0" })

		expect(headers["X-Stainless-OS"]).toBe("Windows")
		expect(headers["X-Stainless-Arch"]).toBe("x64")
		expect(headers["X-Stainless-Runtime-Version"]).toBe("v22.19.0")
		expect(headers["X-Stainless-Runtime"]).toBe("node")
	})

	it("normalises every platform the SDK names", () => {
		expect(stainlessOs("darwin")).toBe("MacOS")
		expect(stainlessOs("linux")).toBe("Linux")
		expect(stainlessOs("freebsd")).toBe("FreeBSD")
		expect(stainlessOs("aix")).toBe("Other:aix")
	})

	it("normalises every architecture the SDK names", () => {
		expect(stainlessArch("arm64")).toBe("arm64")
		expect(stainlessArch("aarch64")).toBe("arm64")
		expect(stainlessArch("x86_64")).toBe("x64")
		// The SDK keeps Node's 32-bit x86 as an unknown architecture.
		expect(stainlessArch("ia32")).toBe("other:ia32")
		expect(stainlessArch("s390x")).toBe("other:s390x")
	})

	it("defaults to the current process", () => {
		const headers = buildClaudeCodeFingerprintHeaders()
		const expectedOs: Record<string, string> = { win32: "Windows", darwin: "MacOS", linux: "Linux" }
		const expectedArch: Record<string, string> = { x64: "x64", arm64: "arm64" }

		// Asserted against literal SDK spellings, not the implementation itself.
		if (expectedOs[process.platform]) expect(headers["X-Stainless-OS"]).toBe(expectedOs[process.platform])
		if (expectedArch[process.arch]) expect(headers["X-Stainless-Arch"]).toBe(expectedArch[process.arch])
		expect(headers["X-Stainless-Runtime-Version"]).toBe(process.version)
	})
})
