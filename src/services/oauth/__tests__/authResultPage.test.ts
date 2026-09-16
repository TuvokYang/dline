import { describe, expect, it } from "vitest"
import { renderAuthResultPage } from "../authResultPage"

const baseOptions = {
	title: "Authorization successful",
	description: "Dline received the authorization result.",
	hint: "You can close this window.",
} as const

describe("renderAuthResultPage", () => {
	it("places the centred Dline mark above every text element", () => {
		const html = renderAuthResultPage({ status: "success", ...baseOptions })

		expect(html.indexOf("<svg")).toBeGreaterThan(-1)
		expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("<h1>"))
		expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf("<p>"))
		expect(html).toContain("flex-direction: column")
		expect(html).toContain("align-items: center")
		expect(html).toContain("margin: 0 auto")
	})

	it("uses the green mark for success and the red mark for failure", () => {
		const success = renderAuthResultPage({ status: "success", ...baseOptions })
		const failure = renderAuthResultPage({ status: "failure", ...baseOptions })

		expect(success).toContain('class="logo success"')
		expect(failure).toContain('class="logo failure"')
		expect(failure).not.toContain("logo success")
	})

	it("renders provider, account, and plan details", () => {
		const html = renderAuthResultPage({
			status: "success",
			...baseOptions,
			account: {
				providerName: "OpenAI Codex",
				accountName: "Ada Lovelace",
				accountDetail: "ada@example.test",
				planName: "Pro",
			},
		})

		expect(html).toContain('<span class="provider">OpenAI Codex</span>')
		expect(html).toContain('<span class="name">Ada Lovelace</span>')
		expect(html).toContain('<span class="detail">ada@example.test</span>')
		expect(html).toContain('<span class="plan">Pro</span>')
	})

	it("omits absent account fields instead of rendering empty nodes", () => {
		const html = renderAuthResultPage({
			status: "success",
			...baseOptions,
			account: { providerName: "OpenAI Codex" },
		})

		expect(html).toContain('<span class="provider">OpenAI Codex</span>')
		expect(html).not.toContain('class="name"')
		expect(html).not.toContain('class="detail"')
		expect(html).not.toContain('class="plan"')
	})

	it("omits the account block entirely when no presentation is supplied", () => {
		const html = renderAuthResultPage({ status: "success", ...baseOptions })

		expect(html).not.toContain('class="account"')
		expect(html).toContain("Authorization successful")
	})

	it("escapes untrusted claim values", () => {
		const html = renderAuthResultPage({
			status: "success",
			...baseOptions,
			account: {
				providerName: "OpenAI Codex",
				accountName: "<script>alert('x')</script>",
				accountDetail: 'a"b&c',
			},
		})

		expect(html).not.toContain("<script>alert")
		expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;")
		expect(html).toContain("a&quot;b&amp;c")
	})

	it("references no external resource", () => {
		const html = renderAuthResultPage({
			status: "success",
			...baseOptions,
			account: { providerName: "OpenAI Codex", accountName: "Ada" },
		})

		expect(html).not.toContain("@import")
		expect(html).not.toContain("http://")
		expect(html).not.toContain("https://fonts")
		expect(html).not.toContain("<script")
		expect(html).toContain('<svg viewBox="0 0 92 96"')
	})
})
