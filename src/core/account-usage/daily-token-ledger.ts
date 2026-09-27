/**
 * Per-Profile token totals for the current local day.
 *
 * Subscription providers (Claude Code, OpenAI Codex) report quota windows but
 * no token counts, so Dline counts the tokens its own requests consumed. The
 * ledger keeps only the latest day per Profile: a new day starts from zero
 * rather than carrying yesterday's totals.
 */

export interface DailyTokenTotals {
	/** Local calendar day, `YYYY-MM-DD`. */
	readonly day: string
	readonly inputTokens: number
	readonly outputTokens: number
}

export type ProfileDailyTokenLedger = Readonly<Record<string, DailyTokenTotals>>

export interface TokenIncrement {
	readonly inputTokens: number
	readonly outputTokens: number
}

/** Local calendar day, because "today" is the user's day, not UTC's. */
export function localDayKey(now: Date): string {
	const month = String(now.getMonth() + 1).padStart(2, "0")
	const day = String(now.getDate()).padStart(2, "0")
	return `${now.getFullYear()}-${month}-${day}`
}

function sanitize(tokens: number): number {
	return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0
}

/** Add one request's tokens, restarting the Profile's totals on a new day. */
export function addDailyTokens(
	ledger: ProfileDailyTokenLedger,
	profileId: string,
	increment: TokenIncrement,
	now: Date,
): ProfileDailyTokenLedger {
	const day = localDayKey(now)
	const current = ledger[profileId]
	const base = current?.day === day ? current : { day, inputTokens: 0, outputTokens: 0 }
	return {
		...ledger,
		[profileId]: {
			day,
			inputTokens: base.inputTokens + sanitize(increment.inputTokens),
			outputTokens: base.outputTokens + sanitize(increment.outputTokens),
		},
	}
}

/** Today's totals for one Profile; zero when it has not been used today. */
export function readDailyTokens(ledger: ProfileDailyTokenLedger | undefined, profileId: string, now: Date): TokenIncrement {
	const entry = ledger?.[profileId]
	if (!entry || entry.day !== localDayKey(now)) return { inputTokens: 0, outputTokens: 0 }
	return { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }
}
