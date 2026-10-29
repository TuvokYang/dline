import { DLINE_MARK_PATH, DLINE_MARK_VIEW_BOX } from "@shared/brand/dlineMarkPaths"
import type { OAuthAccountPresentation } from "./types"

export type AuthResultStatus = "success" | "failure"

export interface AuthResultPageOptions {
    status: AuthResultStatus
    /** Page title and heading text. */
    title: string
    /** Primary explanation rendered under the heading. */
    description: string
    /** Optional closing hint rendered below the account block. */
    hint?: string
    /** Optional account summary. Omitted entirely when absent. */
    account?: OAuthAccountPresentation
}

/**
 * Dline mark inlined as SVG.
 *
 * The callback page is served by a loopback HTTP server that has no access to
 * extension assets, and an external URL would leave the page blank offline or
 * behind a proxy. `currentColor` lets the status drive the mark colour.
 *
 * The SVG namespace attribute is omitted on purpose: inline SVG inside an HTML5
 * document does not need it, and keeping the page free of any absolute URL makes
 * the "no external resource" guarantee checkable by a simple assertion.
 */
const DLINE_MARK = `<svg viewBox="${DLINE_MARK_VIEW_BOX}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${DLINE_MARK_PATH}"></path></svg>`

const PAGE_STYLE = `:root {
	color-scheme: light dark;
	--page-background: #f5f6f8;
	--card-background: #ffffff;
	--card-border: #d8dce2;
	--text-strong: #1f2328;
	--text-muted: #5b6370;
	--chip-background: #eef0f3;
	--logo-idle: #8b949e;
	--logo-success: #2ea043;
	--logo-failure: #d1242f;
}

@media (prefers-color-scheme: dark) {
	:root {
		--page-background: #16181d;
		--card-background: #1e2127;
		--card-border: #30363d;
		--text-strong: #e6edf3;
		--text-muted: #9aa4b2;
		--chip-background: #272b33;
		--logo-idle: #6e7681;
		--logo-success: #3fb950;
		--logo-failure: #f85149;
	}
}

* {
	margin: 0;
	padding: 0;
	box-sizing: border-box;
}

body {
	font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	background-color: var(--page-background);
	color: var(--text-strong);
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	line-height: 1.5;
}

.card {
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
	gap: 16px;
	width: 100%;
	max-width: 460px;
	padding: 40px 32px;
	background-color: var(--card-background);
	border: 1px solid var(--card-border);
	border-radius: 12px;
}

.logo {
	width: 64px;
	height: 64px;
	margin: 0 auto;
	color: var(--logo-idle);
}

.logo.success {
	color: var(--logo-success);
}

.logo.failure {
	color: var(--logo-failure);
}

.logo svg {
	width: 100%;
	height: 100%;
	display: block;
}

h1 {
	font-size: 1.375rem;
	font-weight: 600;
}

p {
	font-size: 0.9375rem;
	color: var(--text-muted);
}

.account {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 16px;
	background-color: var(--chip-background);
	border-radius: 8px;
}

.account .provider {
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--text-muted);
}

.account .name {
	font-size: 1rem;
	font-weight: 600;
	word-break: break-word;
}

.account .detail {
	font-size: 0.8125rem;
	color: var(--text-muted);
	word-break: break-word;
}

.account .plan {
	margin-top: 2px;
	padding: 2px 10px;
	font-size: 0.75rem;
	font-weight: 600;
	color: var(--text-strong);
	background-color: var(--card-background);
	border: 1px solid var(--card-border);
	border-radius: 999px;
}

.hint {
	margin-top: 4px;
	font-size: 1.0625rem;
	font-weight: 700;
	color: var(--text-strong);
}`

/**
 * Escape a value interpolated into the page.
 *
 * Account fields originate from provider token claims, so they are untrusted
 * input even though the page is served over loopback.
 */
function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function renderAccount(account: OAuthAccountPresentation | undefined): string {
    if (!account) return ""
    const rows = [
        account.providerName ? `<span class="provider">${escapeHtml(account.providerName)}</span>` : "",
        account.accountName ? `<span class="name">${escapeHtml(account.accountName)}</span>` : "",
        account.accountDetail ? `<span class="detail">${escapeHtml(account.accountDetail)}</span>` : "",
        account.planName ? `<span class="plan">${escapeHtml(account.planName)}</span>` : "",
    ].filter((row) => row.length > 0)
    if (rows.length === 0) return ""
    return `<div class="account">${rows.join("")}</div>`
}

/**
 * Render the standalone HTML page shown after an OAuth callback.
 *
 * The layout is a single centred column: the Dline mark first, then every text
 * element below it. The mark stays neutral grey and only turns green once the
 * authorization actually succeeded.
 *
 * @param options Status, copy, and the optional account summary.
 * @returns A self-contained HTML document with no external resource references.
 */
export function renderAuthResultPage(options: AuthResultPageOptions): string {
    const logoClass = `logo ${options.status}`
    const hint = options.hint ? `<div class="hint">${escapeHtml(options.hint)}</div>` : ""
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<main class="card">
<div class="${logoClass}">${DLINE_MARK}</div>
<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.description)}</p>
${renderAccount(options.account)}
${hint}
</main>
</body>
</html>`
}
