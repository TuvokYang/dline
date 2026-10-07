/**
 * Selector options for the Anthropic `thinking.display` request field.
 *
 * "None" is a UI-only choice that stores no value, so the field is omitted from the
 * request and the API default applies. The remaining entries mirror the values the
 * Messages API accepts.
 */
export const ANTHROPIC_THINKING_DISPLAY_SELECTOR_OPTIONS = [
	{ value: "none", label: "None" },
	{ value: "summarized", label: "Summarized" },
	{ value: "omitted", label: "Omitted" },
] as const

export const ANTHROPIC_THINKING_DISPLAY_DESCRIPTION =
	"None leaves the choice to Anthropic. Summarized returns thinking normally; Omitted redacts it while keeping multi-turn continuity."
