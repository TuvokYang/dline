/**
 * Color themes a demo can be recorded in. Every README and documentation asset exists in a
 * dark and a light edition; the dark edition keeps the unsuffixed asset name that existing
 * references point at.
 */
export type DemoTheme = "dark" | "light"

/** Playwright option that the demo fixture reads; set per run through {@link DEMO_THEME_ENV}. */
export interface DemoThemeOptions {
    demoTheme: DemoTheme
}

interface DemoThemeSpec {
    /** Built-in theme ID written to the `workbench.colorTheme` user setting before launch. */
    settingsId: string
    /** `data-vscode-theme-kind` of every webview body once VS Code has applied the theme. */
    webviewKind: string
    /** Appended to each asset id so both editions can live in the same directory. */
    assetSuffix: string
}

export const DEMO_THEMES: Readonly<Record<DemoTheme, DemoThemeSpec>> = {
    dark: { settingsId: "Default Dark Modern", webviewKind: "vscode-dark", assetSuffix: "" },
    light: { settingsId: "Default Light Modern", webviewKind: "vscode-light", assetSuffix: "-light" },
}

/** Selects the theme for one `npm run e2e:demo` invocation; unset means dark. */
export const DEMO_THEME_ENV = "DLINE_DEMO_THEME"

export function resolveDemoTheme(value: string | undefined): DemoTheme {
    if (!value) return "dark"
    if (value === "dark" || value === "light") return value
    throw new Error(`${DEMO_THEME_ENV} must be "dark" or "light", got "${value}"`)
}

/** Asset id under which a recording or screenshot of `id` is stored for `theme`. */
export function themedAssetId(id: string, theme: DemoTheme): string {
    return `${id}${DEMO_THEMES[theme].assetSuffix}`
}
