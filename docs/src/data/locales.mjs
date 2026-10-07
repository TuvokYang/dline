/**
 * Site editions. English is served at the site root and Simplified Chinese
 * below /zh-cn/.
 *
 * astro.config.ts and the verification scripts both read this module, so the
 * routing the build produces and the routing the checks expect cannot diverge.
 */

export const ROOT_LOCALE = "root"

/** Locale key of the Chinese edition; also its content directory and URL prefix. */
export const CHINESE_LOCALE = "zh-cn"

export const locales = Object.freeze({
	root: Object.freeze({ label: "English", lang: "en" }),
	[CHINESE_LOCALE]: Object.freeze({ label: "简体中文", lang: "zh-CN" }),
})
